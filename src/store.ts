import { reactive, watch } from 'vue';
import { createInitialState } from './data';
import type { AppealDecision, Lesson, PersistedState, PracticeAttempt, SentenceAppeal } from './types';
import { compareSentence, scoreAttempt } from './utils';

const STORAGE_KEY = 'sologsb-1029-dictation-state-v1';

function loadState(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PersistedState;
      if (parsed.schemaVersion === 1) return parsed;
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

// ---- 逐句申诉（appeal）----

export function appealsForAttempt(attemptId: string): SentenceAppeal[] {
  return state.appeals
    .filter((appeal) => appeal.attemptId === attemptId)
    .sort((a, b) => a.version - b.version || a.createdAt.localeCompare(b.createdAt));
}

export function pendingAppealForSentence(attemptId: string, sentenceId: string): SentenceAppeal | undefined {
  return state.appeals.find((appeal) => appeal.attemptId === attemptId && appeal.sentenceId === sentenceId && appeal.status === 'pending');
}

export function latestAppealForSentence(attemptId: string, sentenceId: string): SentenceAppeal | undefined {
  return state.appeals
    .filter((appeal) => appeal.attemptId === attemptId && appeal.sentenceId === sentenceId)
    .sort((a, b) => b.version - a.version)[0];
}

export function createAppeal(attemptId: string, sentenceId: string, correctedAnswer: string, appealReason: string): { ok: boolean; error?: string; appeal?: SentenceAppeal } {
  const attempt = state.attempts.find((item) => item.id === attemptId);
  const sentenceAttempt = attempt?.sentenceAttempts.find((item) => item.sentenceId === sentenceId);
  if (!attempt || !sentenceAttempt) return { ok: false, error: '未找到对应的作答记录' };
  const corrected = correctedAnswer.trim();
  if (!corrected) return { ok: false, error: '请填写订正答案' };
  if (!appealReason.trim()) return { ok: false, error: '请填写申诉理由（如连读、同义表达）' };
  // 同一句有待处理申诉时不能重复开单
  if (pendingAppealForSentence(attemptId, sentenceId)) return { ok: false, error: '该句已有待处理的申诉，不能重复开单' };
  const version = (latestAppealForSentence(attemptId, sentenceId)?.version ?? 0) + 1;
  const appeal: SentenceAppeal = {
    id: `appeal-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    attemptId,
    sentenceId,
    originalAnswer: sentenceAttempt.answer,
    originalScore: sentenceAttempt.score,
    originalTokens: structuredClone(sentenceAttempt.tokens),
    correctedAnswer: corrected,
    appealReason: appealReason.trim(),
    status: 'pending',
    teacherNote: '',
    processedAt: null,
    createdAt: new Date().toISOString(),
    version,
    conflict: false,
    conflictReason: ''
  };
  state.appeals.push(appeal);
  return { ok: true, appeal };
}

export function withdrawAppeal(appealId: string): { ok: boolean; error?: string } {
  const appeal = state.appeals.find((item) => item.id === appealId);
  if (!appeal) return { ok: false, error: '申诉不存在' };
  if (appeal.status !== 'pending') return { ok: false, error: '只有待处理的申诉可以撤回' };
  appeal.status = 'withdrawn';
  return { ok: true };
}

export function processAppeal(appealId: string, decision: AppealDecision, teacherNote: string): { ok: boolean; error?: string; conflict?: boolean } {
  const appeal = state.appeals.find((item) => item.id === appealId);
  if (!appeal) return { ok: false, error: '申诉不存在' };
  // 乐观锁：处理时若该句已出现更新版本（学生撤回重提），旧决定不得写回成绩
  const latest = latestAppealForSentence(appeal.attemptId, appeal.sentenceId);
  const superseded = !!latest && latest.id !== appealId;
  if (appeal.status !== 'pending') {
    if (superseded) {
      appeal.conflict = true;
      appeal.conflictReason = `处理期间该句出现新订正（第 ${latest!.version} 版），本旧决定不再写回成绩。`;
      return { ok: false, conflict: true, error: appeal.conflictReason };
    }
    return { ok: false, error: '该申诉已处理，不能重复操作' };
  }
  if (superseded) {
    appeal.conflict = true;
    appeal.conflictReason = `处理期间该句出现新订正（第 ${latest!.version} 版），本旧决定不再写回成绩。`;
    return { ok: false, conflict: true, error: appeal.conflictReason };
  }
  if (decision === 'rejected' && !teacherNote.trim()) {
    return { ok: false, error: '驳回时必须写明原因' };
  }
  if (decision === 'approved') {
    const attempt = state.attempts.find((item) => item.id === appeal.attemptId);
    const sentenceAttempt = attempt?.sentenceAttempts.find((item) => item.sentenceId === appeal.sentenceId);
    if (attempt && sentenceAttempt) {
      const newTokens = compareSentence(sentenceAttempt.source, appeal.correctedAnswer);
      const correct = newTokens.filter((token) => token.correct).length;
      sentenceAttempt.tokens = newTokens;
      sentenceAttempt.answer = appeal.correctedAnswer;
      sentenceAttempt.score = newTokens.length ? Math.round((correct / newTokens.length) * 100) : 0;
      attempt.score = scoreAttempt(attempt.sentenceAttempts);
    }
  }
  appeal.status = decision;
  appeal.teacherNote = teacherNote.trim();
  appeal.processedAt = new Date().toISOString();
  return { ok: true };
}

export function exportRecords(): string {
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    application: 'EchoStep 移动听写',
    attempts: state.attempts,
    appeals: state.appeals,
    progress: state.progress
  }, null, 2);
}

export function resetDemo() {
  const fresh = createInitialState();
  Object.assign(state, fresh);
}
