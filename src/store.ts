import { reactive, watch } from 'vue';
import { createInitialState } from './data';
import type {
  AppealDecision,
  Lesson,
  PersistedState,
  PracticeAttempt,
  SentenceAppeal,
  SentenceAttempt
} from './types';
import { cloneData, gradeSentence, scoreAttempt } from './utils';

const STORAGE_KEY = 'sologsb-1029-dictation-state-v1';

export interface AppealActionResult {
  ok: boolean;
  message: string;
}

function migrateV1(raw: Record<string, unknown>): PersistedState {
  const attempts = (raw.attempts as PracticeAttempt[] | undefined) ?? [];
  // 旧版本没有申诉功能，提交时的分数就是原始分数，补齐处理前版本字段。
  attempts.forEach((attempt) => {
    if (attempt.originalScore === undefined) attempt.originalScore = attempt.score;
    attempt.sentenceAttempts.forEach((sentence) => {
      if (sentence.originalScore === undefined) {
        sentence.originalAnswer = sentence.answer;
        sentence.originalScore = sentence.score;
        sentence.originalTokens = cloneData(sentence.tokens);
      }
    });
  });
  return {
    schemaVersion: 2,
    courses: (raw.courses as PersistedState['courses']) ?? createInitialState().courses,
    attempts,
    appeals: [],
    progress: (raw.progress as PersistedState['progress']) ?? {},
    activeLessonId: (raw.activeLessonId as string) ?? '',
    activeSentenceId: (raw.activeSentenceId as string) ?? '',
    theme: (raw.theme as PersistedState['theme']) ?? 'light',
    fontScale: (raw.fontScale as number) ?? 1,
    role: (raw.role as PersistedState['role']) ?? 'learner'
  };
}

function loadState(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown> & { schemaVersion?: number };
      if (parsed.schemaVersion === 2) return parsed as unknown as PersistedState;
      if (parsed.schemaVersion === 1) return migrateV1(parsed);
    }
  } catch {
    // Falls back to the sample course when the local draft is malformed.
  }
  return createInitialState();
}

export const state = reactive<PersistedState>(loadState());

export const persist = () => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
};

watch(state, persist, { deep: true });

export const lessons = (): Lesson[] => state.courses.flatMap((course) => course.lessons);
export const lessonById = (id: string): Lesson | undefined => lessons().find((lesson) => lesson.id === id);
export const courseForLesson = (lessonId: string) => state.courses.find((course) => course.id === lessonById(lessonId)?.courseId);

export function setDownloaded(lessonId: string, value: boolean) {
  const lesson = lessonById(lessonId);
  if (lesson) lesson.downloaded = value;
}

export function saveAttempt(attempt: PracticeAttempt) {
  state.attempts.unshift(attempt);
}

export function updateTokenClassification(attemptId: string, sentenceId: string, tokenIndex: number, patch: { category?: PracticeAttempt['sentenceAttempts'][number]['tokens'][number]['category']; reason?: string }) {
  const attempt = state.attempts.find((item) => item.id === attemptId);
  const token = attempt?.sentenceAttempts.find((item) => item.sentenceId === sentenceId)?.tokens.find((item) => item.index === tokenIndex);
  if (token) Object.assign(token, patch);
}

/* ---------------- 逐句申诉 ---------------- */

export const findAttempt = (attemptId: string): PracticeAttempt | undefined =>
  state.attempts.find((item) => item.id === attemptId);

export const findSentenceAttempt = (attempt: PracticeAttempt, sentenceId: string): SentenceAttempt | undefined =>
  attempt.sentenceAttempts.find((item) => item.sentenceId === sentenceId);

/** 该句全部申诉单，按发起时间从新到旧排列。 */
export function appealsForSentence(attemptId: string, sentenceId: string): SentenceAppeal[] {
  return state.appeals
    .filter((appeal) => appeal.attemptId === attemptId && appeal.sentenceId === sentenceId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export const activeAppealForSentence = (attemptId: string, sentenceId: string): SentenceAppeal | undefined =>
  state.appeals.find((appeal) => appeal.attemptId === attemptId && appeal.sentenceId === sentenceId && appeal.status === 'pending');

/** 教师页待处理队列；其余申诉单排在后面供核对。 */
export function appealsByRecency(): SentenceAppeal[] {
  return [...state.appeals].sort((a, b) => {
    if ((a.status === 'pending') !== (b.status === 'pending')) return a.status === 'pending' ? -1 : 1;
    return b.createdAt.localeCompare(a.createdAt);
  });
}

export function pendingAppealCount(): number {
  return state.appeals.filter((appeal) => appeal.status === 'pending').length;
}

/**
 * 学生发起逐句申诉。同一句存在待处理申诉时拒绝重复开单；
 * 订正与当前答案完全相同则没有申诉必要。
 * 撤回后用新订重重提时，上一单标记为 superseded 并指向新单。
 */
export function createAppeal(attemptId: string, sentenceId: string, correctedAnswer: string, reason: string): AppealActionResult {
  const attempt = findAttempt(attemptId);
  const sentence = attempt ? findSentenceAttempt(attempt, sentenceId) : undefined;
  if (!attempt || !sentence) return { ok: false, message: '未找到对应的作答记录' };
  if (activeAppealForSentence(attemptId, sentenceId)) {
    return { ok: false, message: '该句已有待处理申诉，请等待教师处理或先撤回' };
  }
  const trimmed = correctedAnswer.trim();
  if (!trimmed) return { ok: false, message: '请先填写订正答案再申诉' };
  if (trimmed === sentence.answer.trim()) return { ok: false, message: '订正答案与原答案相同，无需申诉' };

  const now = new Date().toISOString();
  const sentenceIndex = attempt.sentenceAttempts.findIndex((item) => item.sentenceId === sentenceId);
  const { tokens: correctedTokens, score: correctedScore } = gradeSentence(sentence.source, trimmed);

  // 冻结发起时的原判快照，确保处理前后版本都可核对。
  const appeal: SentenceAppeal = {
    id: `appeal-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    attemptId,
    sentenceId,
    sentenceIndex,
    source: sentence.source,
    reason: reason.trim(),
    status: 'pending',
    createdAt: now,
    originalAnswer: sentence.answer,
    originalScore: sentence.score,
    originalTokens: cloneData(sentence.tokens),
    correctedAnswer: trimmed,
    correctedScore,
    correctedTokens
  };

  // 撤回后重提：旧申诉立即失效，并记录被哪一单取代。
  const lastClosed = appealsForSentence(attemptId, sentenceId)[0];
  if (lastClosed && lastClosed.status === 'withdrawn') {
    lastClosed.status = 'superseded';
    lastClosed.supersededByAppealId = appeal.id;
    lastClosed.conflictNote = `学生已于 ${now} 撤回本单并用新订重重提，本单不再作为处理依据。`;
  }

  state.appeals.unshift(appeal);
  return { ok: true, message: '申诉已提交，等待教师处理' };
}

/** 学生只能在教师处理之前撤回；撤回后可立即用新订重重提。 */
export function withdrawAppeal(appealId: string): AppealActionResult {
  const appeal = state.appeals.find((item) => item.id === appealId);
  if (!appeal) return { ok: false, message: '未找到该申诉单' };
  if (appeal.status !== 'pending') return { ok: false, message: '教师已处理，无法撤回' };
  appeal.status = 'withdrawn';
  appeal.withdrawnAt = new Date().toISOString();
  return { ok: true, message: '申诉已撤回，可修改后重新提交' };
}

/**
 * 教师裁决申诉。
 * 通过：把订正答案与重新判定写回单句，并重算整课成绩；同时冻结处理前版本。
 * 驳回：原结果完全保留，教师意见（驳回原因）随单记录。
 * 若申诉单在处理期间已被撤回重提（superseded），旧决定一律不写回成绩，
 * 只把该单标记为 conflict 并写明冲突缘由。
 */
export function decideAppeal(appealId: string, decision: AppealDecision, teacherNote: string): AppealActionResult {
  const appeal = state.appeals.find((item) => item.id === appealId);
  if (!appeal) return { ok: false, message: '未找到该申诉单' };
  if (appeal.status !== 'pending') return { ok: false, message: '该申诉单已处理' };

  const note = teacherNote.trim();
  if (decision === 'rejected' && !note) {
    return { ok: false, message: '驳回时必须写明原因' };
  }

  // 并发保护：pending 单必须是该句当前唯一的活动申诉；
  // 保证“处理期间出现新订正”时旧决定绝不能写回成绩。
  const isStale = appealId !== activeAppealForSentence(appeal.attemptId, appeal.sentenceId)?.id;
  if (isStale) {
    appeal.status = 'conflict';
    appeal.decidedAt = new Date().toISOString();
    appeal.teacherNote = note || undefined;
    appeal.conflictNote = '处理期间学生已撤回并用新订重重提，本决定对应的订正已过期，未写回任何成绩，请处理最新申诉单。';
    return { ok: false, message: '该申诉已被新订正取代，旧决定未写回成绩（已标记冲突）' };
  }

  const attempt = findAttempt(appeal.attemptId);
  const sentence = attempt ? findSentenceAttempt(attempt, appeal.sentenceId) : undefined;
  if (!attempt || !sentence) {
    appeal.status = 'conflict';
    appeal.conflictNote = '对应的作答或句子已不存在，决定无法写回成绩。';
    appeal.decidedAt = new Date().toISOString();
    return { ok: false, message: '对应作答已不存在，已标记冲突' };
  }

  if (decision === 'approved') {
    // 保留处理前版本，供结果页、教师页与导出核对。
    if (sentence.originalScore === undefined) {
      sentence.originalAnswer = sentence.answer;
      sentence.originalScore = sentence.score;
      sentence.originalTokens = cloneData(sentence.tokens);
    }
    if (attempt.originalScore === undefined) attempt.originalScore = attempt.score;

    sentence.answer = appeal.correctedAnswer;
    sentence.tokens = cloneData(appeal.correctedTokens);
    sentence.score = appeal.correctedScore;
    sentence.adjustedByAppealId = appeal.id;
    attempt.score = scoreAttempt(attempt.sentenceAttempts);

    appeal.status = 'approved';
    appeal.decidedAt = new Date().toISOString();
    appeal.teacherNote = note || undefined;
    return { ok: true, message: `已通过：单句 ${appeal.originalScore} → ${appeal.correctedScore} 分，整课成绩已更新` };
  }

  appeal.status = 'rejected';
  appeal.decidedAt = new Date().toISOString();
  appeal.teacherNote = note;
  return { ok: true, message: '已驳回，原结果保留' };
}

/** 给申诉单补记冲突结果（教师页“补记迟到决定”用）：决定不写回任何成绩。 */
export function resolveStaleDecision(appealId: string, decision: AppealDecision, teacherNote: string): AppealActionResult {
  const appeal = state.appeals.find((item) => item.id === appealId);
  if (!appeal) return { ok: false, message: '未找到该申诉单' };
  if (appeal.status !== 'superseded') return { ok: false, message: '只有被新订正取代的旧单可补记冲突决定' };
  const note = teacherNote.trim();
  if (decision === 'rejected' && !note) return { ok: false, message: '驳回时必须写明原因' };
  appeal.status = 'conflict';
  appeal.decidedAt = new Date().toISOString();
  appeal.teacherNote = note || undefined;
  appeal.conflictNote = `教师对旧单作出“${decision === 'approved' ? '通过' : '驳回'}”决定时，学生已撤回并用新订重重提；旧决定未写回成绩。`;
  return { ok: true, message: '已补记冲突：旧决定未写回成绩' };
}

export function exportRecords(): string {
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    application: 'EchoStep 移动听写',
    schemaVersion: 2,
    attempts: state.attempts.map((attempt) => ({
      ...attempt,
      // 导出同时给出处理前/处理后整课分数，便于核对。
      scoreVersion: attempt.originalScore !== undefined && attempt.originalScore !== attempt.score
        ? { beforeAppeal: attempt.originalScore, afterAppeal: attempt.score }
        : { beforeAppeal: attempt.score, afterAppeal: attempt.score },
      sentenceAttempts: attempt.sentenceAttempts.map((sentence) => ({
        ...sentence,
        scoreVersion: {
          beforeAppeal: sentence.originalScore ?? sentence.score,
          afterAppeal: sentence.score
        }
      }))
    })),
    appeals: state.appeals,
    progress: state.progress
  }, null, 2);
}

export function resetDemo() {
  const fresh = createInitialState();
  Object.assign(state, fresh);
}
