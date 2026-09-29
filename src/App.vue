<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  activeAppealForSentence,
  appealsByRecency,
  appealsForSentence,
  courseForLesson,
  createAppeal,
  decideAppeal,
  exportRecords,
  findAttempt,
  lessonById,
  pendingAppealCount,
  persist,
  resolveStaleDecision,
  saveAttempt,
  setDownloaded,
  state,
  updateTokenClassification,
  withdrawAppeal
} from './store';
import type { AppealDecision, AppealStatus, ErrorCategory, Lesson, PracticeAttempt, PracticeView, SentenceAppeal } from './types';
import { cloneData, gradeSentence, scoreAttempt, segmentText } from './utils';

const view = ref<PracticeView>(state.activeLessonId ? 'practice' : 'library');
const online = ref(navigator.onLine);
const toast = ref('');
const resultAttemptId = ref('');
const selectedResultSentence = ref(0);
const segmentStart = ref(0);
const segmentEnd = ref(1);
const teacherAttemptId = ref(state.attempts[0]?.id ?? '');
const teacherDraft = ref(state.attempts[0]?.teacherFeedback ?? '');
// 学习端逐句申诉表单
const appealCorrection = ref('');
const appealReason = ref('');
// 教师页每单的处理意见草稿（驳回原因）
const teacherAppealNotes = ref<Record<string, string>>({});
let toastTimer = 0;

const activeLesson = computed(() => lessonById(state.activeLessonId));
const activeCourse = computed(() => activeLesson.value ? courseForLesson(activeLesson.value.id) : undefined);
const currentSentence = computed(() => {
  const lesson = activeLesson.value;
  if (!lesson) return undefined;
  return lesson.sentences.find((sentence) => sentence.id === state.activeSentenceId) ?? lesson.sentences[0];
});
const activeProgress = computed(() => activeLesson.value ? state.progress[activeLesson.value.id] : undefined);
const currentAnswer = ref('');
const currentIndex = computed(() => {
  if (!activeLesson.value || !currentSentence.value) return 0;
  return activeLesson.value.sentences.findIndex((item) => item.id === currentSentence.value?.id);
});
const lessonCompletion = computed(() => {
  if (!activeLesson.value || !activeProgress.value) return 0;
  const answered = activeLesson.value.sentences.filter((sentence) => (activeProgress.value?.answers[sentence.id] ?? '').trim()).length;
  return Math.round((answered / activeLesson.value.sentences.length) * 100);
});
const resultAttempt = computed(() => state.attempts.find((attempt) => attempt.id === resultAttemptId.value));
const resultSentence = computed(() => resultAttempt.value?.sentenceAttempts[selectedResultSentence.value]);
const resultSentenceAppeals = computed<SentenceAppeal[]>(() =>
  resultAttempt.value && resultSentence.value
    ? appealsForSentence(resultAttempt.value.id, resultSentence.value.sentenceId)
    : []
);
const resultSentenceActiveAppeal = computed<SentenceAppeal | undefined>(() =>
  resultAttempt.value && resultSentence.value
    ? activeAppealForSentence(resultAttempt.value.id, resultSentence.value.sentenceId)
    : undefined
);
// 结果页句子导航用：哪些句子存在待处理申诉
const pendingAppealBySentence = computed<Record<string, boolean>>(() => {
  const map: Record<string, boolean> = {};
  state.appeals.forEach((appeal) => {
    if (appeal.status === 'pending') map[`${appeal.attemptId}:${appeal.sentenceId}`] = true;
  });
  return map;
});
const teacherAttempt = computed(() => state.attempts.find((attempt) => attempt.id === teacherAttemptId.value));
const teacherAppeals = computed<SentenceAppeal[]>(() => appealsByRecency());
const totalWords = computed(() => state.attempts.flatMap((attempt) => attempt.sentenceAttempts).flatMap((item) => item.tokens).length);
const correctedWords = computed(() => state.attempts.flatMap((attempt) => attempt.sentenceAttempts).flatMap((item) => item.tokens).filter((token) => !token.correct && token.category !== 'unclassified').length);

const appealStatusMeta: Record<AppealStatus, { label: string; tone: string }> = {
  pending: { label: '待教师处理', tone: 'pending' },
  approved: { label: '教师已通过', tone: 'approved' },
  rejected: { label: '教师已驳回', tone: 'rejected' },
  withdrawn: { label: '已撤回', tone: 'withdrawn' },
  superseded: { label: '旧单已失效', tone: 'superseded' },
  conflict: { label: '冲突 · 未写回', tone: 'conflict' }
};

const categoryOptions: Array<{ value: ErrorCategory; label: string }> = [
  { value: 'unclassified', label: '未分类' },
  { value: 'spelling', label: '拼写错误' },
  { value: 'omitted', label: '漏词' },
  { value: 'extra', label: '多词' },
  { value: 'punctuation', label: '标点' },
  { value: 'grammar', label: '语法' }
];

watch(currentSentence, (sentence) => {
  currentAnswer.value = sentence && activeProgress.value ? activeProgress.value.answers[sentence.id] ?? '' : '';
  segmentStart.value = 0;
  segmentEnd.value = sentence ? Math.max(0, segmentText(sentence.text).length - 1) : 0;
}, { immediate: true });

watch(currentAnswer, (value) => {
  const lesson = activeLesson.value;
  const sentence = currentSentence.value;
  if (!lesson || !sentence) return;
  const progress = state.progress[lesson.id] ?? { answers: {}, activeSentenceId: sentence.id, updatedAt: new Date().toISOString() };
  progress.answers[sentence.id] = value;
  progress.activeSentenceId = sentence.id;
  progress.updatedAt = new Date().toISOString();
  state.progress[lesson.id] = progress;
});

watch(activeLesson, (lesson) => {
  if (!lesson) return;
  state.activeLessonId = lesson.id;
  state.activeSentenceId = currentSentence.value?.id ?? lesson.sentences[0].id;
  const progress = state.progress[lesson.id] ?? { answers: {}, activeSentenceId: lesson.sentences[0].id, updatedAt: new Date().toISOString() };
  if (!lesson.sentences.some((sentence) => sentence.id === progress.activeSentenceId)) progress.activeSentenceId = lesson.sentences[0].id;
  state.progress[lesson.id] = progress;
  state.activeSentenceId = progress.activeSentenceId;
  currentAnswer.value = progress.answers[state.activeSentenceId] ?? '';
});

watch(teacherAttemptId, (id) => {
  teacherDraft.value = state.attempts.find((attempt) => attempt.id === id)?.teacherFeedback ?? '';
});

function notify(message: string) {
  toast.value = message;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toast.value = ''; }, 2400);
}

function startLesson(lesson: Lesson) {
  const progress = state.progress[lesson.id] ?? { answers: {}, activeSentenceId: lesson.sentences[0].id, updatedAt: new Date().toISOString() };
  state.progress[lesson.id] = progress;
  state.activeLessonId = lesson.id;
  state.activeSentenceId = progress.activeSentenceId || lesson.sentences[0].id;
  currentAnswer.value = progress.answers[state.activeSentenceId] ?? '';
  view.value = 'practice';
  persist();
}

function goToSentence(index: number) {
  const lesson = activeLesson.value;
  if (!lesson || !lesson.sentences[index]) return;
  const target = lesson.sentences[index];
  state.activeSentenceId = target.id;
  const progress = state.progress[lesson.id];
  if (progress) {
    progress.activeSentenceId = target.id;
    progress.updatedAt = new Date().toISOString();
  }
  currentAnswer.value = progress?.answers[target.id] ?? '';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function submitLesson() {
  const lesson = activeLesson.value;
  const course = activeCourse.value;
  if (!lesson || !course) return;
  const progress = state.progress[lesson.id];
  const answeredCount = lesson.sentences.filter((sentence) => (progress?.answers[sentence.id] ?? '').trim()).length;
  if (!answeredCount) {
    notify('请至少输入一句话再提交');
    return;
  }
  if (answeredCount < lesson.sentences.length && !window.confirm(`还有 ${lesson.sentences.length - answeredCount} 句未作答，仍然提交吗？`)) return;
  const sentenceAttempts = lesson.sentences.map((sentence) => {
    const source = sentence.text;
    const answer = progress?.answers[sentence.id] ?? '';
    const { tokens, score } = gradeSentence(source, answer);
    return {
      sentenceId: sentence.id,
      source,
      answer,
      tokens: cloneData(tokens),
      score,
      originalAnswer: answer,
      originalScore: score,
      originalTokens: cloneData(tokens)
    };
  });
  const totalScore = scoreAttempt(sentenceAttempts);
  const attempt: PracticeAttempt = {
    id: `attempt-${Date.now()}`,
    lessonId: lesson.id,
    lessonTitle: lesson.title,
    courseTitle: course.title,
    submittedAt: new Date().toISOString(),
    score: totalScore,
    originalScore: totalScore,
    sentenceAttempts,
    teacherFeedback: ''
  };
  saveAttempt(attempt);
  resultAttemptId.value = attempt.id;
  selectedResultSentence.value = 0;
  syncSegment();
  view.value = 'result';
  persist();
  notify('已提交，逐词结果已生成');
}

function syncSegment() {
  const tokenCount = segmentText(resultSentence.value?.source ?? '').length;
  segmentStart.value = 0;
  segmentEnd.value = Math.max(0, tokenCount - 1);
}

function replay(text: string, rate = 0.82) {
  if (!('speechSynthesis' in window)) {
    notify('当前浏览器不支持语音播放');
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'en-US';
  utterance.rate = rate;
  window.speechSynthesis.speak(utterance);
}

function replaySegment() {
  const tokens = segmentText(resultSentence.value?.source ?? '');
  const start = Math.min(segmentStart.value, segmentEnd.value);
  const end = Math.max(segmentStart.value, segmentEnd.value);
  replay(tokens.slice(start, end + 1).map((token) => token.display).join(' '), 0.72);
}

function selectResultSentence(index: number) {
  selectedResultSentence.value = index;
  syncSegment();
}

// 切换句子时，用当前答案预填订正框，方便按连读/同义表达小改。
watch([selectedResultSentence, resultAttemptId, resultSentenceAppeals], () => {
  appealReason.value = '';
  const active = resultSentenceActiveAppeal.value;
  appealCorrection.value = active ? active.correctedAnswer : (resultSentence.value?.answer ?? '');
}, { immediate: true });

function submitAppeal() {
  const attempt = resultAttempt.value;
  const sentence = resultSentence.value;
  if (!attempt || !sentence) return;
  const result = createAppeal(attempt.id, sentence.sentenceId, appealCorrection.value, appealReason.value);
  notify(result.message);
  if (result.ok) {
    appealReason.value = '';
    persist();
  }
}

function withdrawCurrentAppeal(appealId: string) {
  const result = withdrawAppeal(appealId);
  notify(result.message);
  if (result.ok) persist();
}

function teacherDecideAppeal(appeal: SentenceAppeal, decision: AppealDecision) {
  const result = decideAppeal(appeal.id, decision, teacherAppealNotes.value[appeal.id] ?? '');
  notify(result.message);
  if (result.ok) {
    teacherAppealNotes.value[appeal.id] = '';
    persist();
  }
}

function teacherResolveStale(appeal: SentenceAppeal, decision: AppealDecision) {
  const result = resolveStaleDecision(appeal.id, decision, teacherAppealNotes.value[appeal.id] ?? '');
  notify(result.message);
  if (result.ok) {
    teacherAppealNotes.value[appeal.id] = '';
    persist();
  }
}

function appealAttempt(appeal: SentenceAppeal): PracticeAttempt | undefined {
  return findAttempt(appeal.attemptId);
}

function saveClassification(attemptId: string, sentenceId: string, tokenIndex: number, category: ErrorCategory, reason: string) {
  updateTokenClassification(attemptId, sentenceId, tokenIndex, { category, reason });
  persist();
}

function saveTeacherFeedback() {
  const attempt = teacherAttempt.value;
  if (!attempt) return;
  attempt.teacherFeedback = teacherDraft.value.trim();
  persist();
  notify('教师反馈已保存');
}

function toggleTheme() {
  state.theme = state.theme === 'light' ? 'dark' : 'light';
}

function changeFont(delta: number) {
  state.fontScale = Math.min(1.25, Math.max(0.85, Number((state.fontScale + delta).toFixed(2))));
}

function downloadRecords() {
  const blob = new Blob([exportRecords()], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `echo-step-records-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  notify('练习记录已导出');
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function onConnectionChange() {
  online.value = navigator.onLine;
  persist();
}

function onVisibilityChange() {
  if (document.visibilityState === 'hidden') persist();
}

onMounted(() => {
  window.addEventListener('online', onConnectionChange);
  window.addEventListener('offline', onConnectionChange);
  window.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', persist);
});

onBeforeUnmount(() => {
  window.removeEventListener('online', onConnectionChange);
  window.removeEventListener('offline', onConnectionChange);
  window.removeEventListener('visibilitychange', onVisibilityChange);
  window.removeEventListener('pagehide', persist);
  persist();
});
</script>

<template>
  <var-app>
    <div class="app-shell" :data-theme="state.theme" :style="{ '--font-scale': state.fontScale }">
      <div v-if="view === 'library'" class="page">
        <header class="topbar">
          <div class="brand">
            <div class="brand-mark">E</div>
            <div><h1>EchoStep</h1><p>移动端语言听写</p></div>
          </div>
          <div class="icon-row">
            <button class="icon-button" :aria-label="state.theme === 'light' ? '切换到深色模式' : '切换到浅色模式'" @click="toggleTheme">{{ state.theme === 'light' ? '◐' : '☀' }}</button>
            <button class="icon-button" aria-label="减小字号" @click="changeFont(-0.05)">A−</button>
            <button class="icon-button" aria-label="增大字号" @click="changeFont(0.05)">A＋</button>
          </div>
        </header>

        <section class="hero">
          <h2>今天也把声音变成文字</h2>
          <p>下载课程后可离线作答，答案和当前位置会自动恢复。</p>
          <div class="hero-stats">
            <div class="hero-stat"><strong>{{ state.attempts.length }}</strong><span>练习记录</span></div>
            <div class="hero-stat"><strong>{{ correctedWords }}</strong><span>已分类错误</span></div>
            <div class="hero-stat"><strong>{{ totalWords }}</strong><span>累计词数</span></div>
          </div>
        </section>

        <div class="offline-banner" :class="{ online }">
          <span>{{ online ? '● 在线 · 数据已保存到本机' : '● 离线模式 · 可继续已下载课程' }}</span>
          <span>{{ online ? '本地优先存储' : '恢复网络后继续保存' }}</span>
        </div>

        <div class="section-head">
          <h3>课程库</h3>
          <div class="segmented">
            <button :class="{ active: state.role === 'learner' }" @click="state.role = 'learner'; view = 'library'">学习</button>
            <button :class="{ active: state.role === 'teacher' }" @click="state.role = 'teacher'; view = 'teacher'">教师</button>
          </div>
        </div>

        <article v-for="course in state.courses" :key="course.id" class="course-card">
          <div class="course-title">
            <div><h3>{{ course.title }}</h3><p>{{ course.description }}</p></div>
            <span class="level-badge">{{ course.level }}</span>
          </div>
          <div v-for="lesson in course.lessons" :key="lesson.id" class="lesson-row">
            <div><h4>{{ lesson.title }}</h4><p>{{ lesson.subtitle }} · {{ lesson.sentences.length }} 句 · 约 {{ lesson.estimatedMinutes }} 分钟</p></div>
            <div class="lesson-actions">
              <var-switch :model-value="lesson.downloaded" @update:model-value="setDownloaded(lesson.id, $event as boolean)" />
              <var-button type="primary" size="small" @click="startLesson(lesson)">{{ lesson.downloaded ? '继续' : '开始' }}</var-button>
            </div>
          </div>
        </article>

        <div class="section-head"><h3>最近练习</h3><span>{{ state.attempts.length }} 条记录</span></div>
        <article v-if="state.attempts.length" class="panel">
          <div v-for="attempt in state.attempts.slice(0, 4)" :key="attempt.id" class="history-card">
            <div class="history-top">
              <strong>{{ attempt.lessonTitle }}</strong>
              <span class="history-score">
                {{ attempt.score }} 分
                <small v-if="attempt.originalScore !== undefined && attempt.originalScore !== attempt.score" class="score-old">（原判 {{ attempt.originalScore }}）</small>
              </span>
            </div>
            <p>{{ formatDate(attempt.submittedAt) }} · {{ attempt.teacherFeedback || '暂无教师反馈' }}</p>
          </div>
          <var-button block type="primary" variant="outline" @click="downloadRecords">导出全部练习记录</var-button>
        </article>
        <div v-else class="empty-state"><strong>还没有练习记录</strong>完成一次听写后，可在这里复核和导出。</div>
      </div>

      <div v-else-if="view === 'practice' && activeLesson" class="page">
        <header class="practice-header">
          <div class="practice-nav">
            <button class="back-button" aria-label="返回课程库" @click="view = 'library'">‹</button>
            <div><h2>{{ activeLesson.title }}</h2></div>
            <span class="status-chip">{{ online ? '在线' : '离线' }}</span>
          </div>
          <div class="progress-line">
            <div class="sentence-count"><span>第 {{ currentIndex + 1 }} / {{ activeLesson.sentences.length }} 句</span><span>{{ lessonCompletion }}% 已填写</span></div>
            <var-progress :value="lessonCompletion" color="#1769e0" />
          </div>
        </header>

        <section class="audio-card">
          <div class="audio-meta">
            <button class="play-button" aria-label="播放当前句子" @click="replay(currentSentence?.text ?? '')">▶</button>
            <div><strong>听写提示</strong><p>先完整播放，再输入你听到的英文。播放速度已放慢。</p></div>
          </div>
        </section>

        <div class="dictation-label"><strong>输入听到的内容</strong><span>答案在本机自动保存</span></div>
        <textarea v-model="currentAnswer" class="answer-box" :aria-label="`第 ${currentIndex + 1} 句听写答案`" placeholder="Type what you hear..." @keydown.ctrl.enter="submitLesson" @keydown.meta.enter="submitLesson"></textarea>
        <div class="practice-actions">
          <var-button block type="default" variant="outline" @click="replay(currentSentence?.text ?? '')">再听一次</var-button>
          <var-button block type="primary" @click="submitLesson">提交本次听写</var-button>
        </div>

        <div class="sentence-picker" aria-label="句子导航">
          <button v-for="(sentence, index) in activeLesson.sentences" :key="sentence.id" class="sentence-dot" :class="{ active: sentence.id === currentSentence?.id, done: !!activeProgress?.answers[sentence.id] }" :aria-label="`跳到第 ${index + 1} 句`" @click="goToSentence(index)">{{ index + 1 }}</button>
        </div>

        <section v-if="currentSentence" class="panel">
          <div class="detail-head"><div><h3>场景提示</h3><p>{{ currentSentence.translation }}</p></div></div>
          <div class="feedback-card">{{ currentSentence.note }}</div>
        </section>
      </div>

      <div v-else-if="view === 'result' && resultAttempt" class="page">
        <header class="topbar">
          <button class="back-button" aria-label="返回课程库" @click="view = 'library'">‹</button>
          <span class="status-chip">提交于 {{ formatDate(resultAttempt.submittedAt) }}</span>
          <button class="icon-button" @click="downloadRecords">导出</button>
        </header>

        <section class="panel result-score">
          <div class="score-ring" :style="{ '--score': `${resultAttempt.score}%` }"><strong>{{ resultAttempt.score }}</strong></div>
          <h2>{{ resultAttempt.score >= 90 ? '几乎完美' : resultAttempt.score >= 70 ? '继续打磨细节' : '再听一遍会更好' }}</h2>
          <p>{{ resultAttempt.lessonTitle }} · 点击红色词可单独重听，并记录错误原因。</p>
          <p v-if="resultAttempt.originalScore !== undefined && resultAttempt.originalScore !== resultAttempt.score" class="score-version">
            申诉处理前整课 {{ resultAttempt.originalScore }} 分 → 处理后 {{ resultAttempt.score }} 分
          </p>
          <p v-else class="score-version muted">当前成绩即提交时原判，尚未被申诉改动</p>
        </section>

        <div class="sentence-picker">
          <button v-for="(attempt, index) in resultAttempt.sentenceAttempts" :key="attempt.sentenceId" class="sentence-dot" :class="{ active: index === selectedResultSentence, done: !!pendingAppealBySentence[`${resultAttempt.id}:${attempt.sentenceId}`] }" :aria-label="`第 ${index + 1} 句，有申诉`" @click="selectResultSentence(index)">{{ index + 1 }}</button>
        </div>

        <section v-if="resultSentence" class="panel token-panel">
          <div class="detail-head">
            <div><h3>第 {{ selectedResultSentence + 1 }} 句逐词结果</h3><p>{{ resultSentence.source }}</p></div>
            <span class="history-score">
              {{ resultSentence.score }}%
              <small v-if="resultSentence.originalScore !== undefined && resultSentence.originalScore !== resultSentence.score" class="score-old">（原判 {{ resultSentence.originalScore }}%）</small>
            </span>
          </div>
          <div class="word-list">
            <button v-for="token in resultSentence.tokens" :key="`${token.index}-${token.expected}-${token.actual}`" class="word-chip" :class="{ wrong: !token.correct }" :title="token.correct ? '点击重听' : `你的答案：${token.actual || '未输入'}`" @click="replay(token.expected || token.actual, 0.7)">
              {{ token.expected || `[+${token.actual}]` }}<small v-if="!token.correct">{{ token.actual || '漏词' }}</small>
            </button>
          </div>

          <div v-if="resultSentence.tokens.some((token) => !token.correct)" style="margin-top: 18px">
            <div class="dictation-label"><strong>片段重听</strong><span>选择起止词后播放</span></div>
            <div style="display: grid; grid-template-columns: 1fr 1fr auto; gap: 8px; align-items: center">
              <select v-model.number="segmentStart" aria-label="片段起点"><option v-for="token in segmentText(resultSentence.source)" :key="`s-${token.index}`" :value="token.index">{{ token.index + 1 }} · {{ token.display }}</option></select>
              <select v-model.number="segmentEnd" aria-label="片段终点"><option v-for="token in segmentText(resultSentence.source)" :key="`e-${token.index}`" :value="token.index">{{ token.index + 1 }} · {{ token.display }}</option></select>
              <var-button type="primary" size="small" @click="replaySegment">播放片段</var-button>
            </div>
          </div>

          <div v-if="resultSentence.tokens.some((token) => !token.correct)" style="margin-top: 18px">
            <div class="dictation-label"><strong>错误分类与原因</strong><span>会被写入本地记录</span></div>
            <div v-for="token in resultSentence.tokens.filter((item) => !item.correct)" :key="`edit-${token.index}`" class="feedback-card">
              <strong>{{ token.expected || `多出的词：${token.actual}` }}</strong>
              <div style="display: grid; grid-template-columns: 120px 1fr; gap: 8px; margin-top: 9px">
                <select :value="token.category" @change="saveClassification(resultAttempt.id, resultSentence.sentenceId, token.index, ($event.target as HTMLSelectElement).value as ErrorCategory, token.reason)">
                  <option v-for="option in categoryOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
                </select>
                <input :value="token.reason" placeholder="记录原因，如连读、词尾未听清" @change="saveClassification(resultAttempt.id, resultSentence.sentenceId, token.index, token.category, ($event.target as HTMLInputElement).value)" />
              </div>
            </div>
          </div>

          <div class="appeal-zone">
            <div class="dictation-label"><strong>逐句申诉</strong><span>连读、同义表达被判错时可发起</span></div>

            <!-- 待处理中的单子：不能重复开单，可在处理前撤回 -->
            <div v-if="resultSentenceActiveAppeal" class="appeal-card" :data-tone="appealStatusMeta[resultSentenceActiveAppeal.status].tone">
              <div class="appeal-head">
                <span class="appeal-badge">{{ appealStatusMeta[resultSentenceActiveAppeal.status].label }}</span>
                <span class="appeal-time">{{ formatDate(resultSentenceActiveAppeal.createdAt) }}</span>
              </div>
              <div class="appeal-grid">
                <div><small>原答案（原判 {{ resultSentenceActiveAppeal.originalScore }} 分）</small><p>{{ resultSentenceActiveAppeal.originalAnswer || '（空）' }}</p></div>
                <div><small>订正答案（拟判 {{ resultSentenceActiveAppeal.correctedScore }} 分）</small><p>{{ resultSentenceActiveAppeal.correctedAnswer }}</p></div>
              </div>
              <p v-if="resultSentenceActiveAppeal.reason" class="appeal-reason">申诉理由：{{ resultSentenceActiveAppeal.reason }}</p>
              <p class="appeal-hint">教师处理通过后才会更新本句与整课成绩；处理前可撤回并用新订重重提。</p>
              <var-button block type="default" variant="outline" @click="withdrawCurrentAppeal(resultSentenceActiveAppeal.id)">撤回本单并重提</var-button>
            </div>

            <template v-else>
              <!-- 历史申诉单：处理前后版本、驳回原因、冲突缘由都可核对 -->
              <div v-for="appeal in resultSentenceAppeals" :key="appeal.id" class="appeal-card" :data-tone="appealStatusMeta[appeal.status].tone">
                <div class="appeal-head">
                  <span class="appeal-badge">{{ appealStatusMeta[appeal.status].label }}</span>
                  <span class="appeal-time">{{ formatDate(appeal.createdAt) }}</span>
                </div>
                <div class="appeal-grid">
                  <div><small>原答案 · {{ appeal.originalScore }} 分</small><p>{{ appeal.originalAnswer || '（空）' }}</p></div>
                  <div><small>订正答案 · {{ appeal.correctedScore }} 分</small><p>{{ appeal.correctedAnswer }}</p></div>
                </div>
                <p v-if="appeal.reason" class="appeal-reason">申诉理由：{{ appeal.reason }}</p>
                <p v-if="appeal.status === 'approved'" class="appeal-note">教师通过（{{ formatDate(appeal.decidedAt!) }}）：订正已写回本句与整课成绩。<template v-if="appeal.teacherNote">{{ appeal.teacherNote }}</template></p>
                <p v-else-if="appeal.status === 'rejected'" class="appeal-note">驳回原因（{{ formatDate(appeal.decidedAt!) }}）：{{ appeal.teacherNote }}　原结果保留。</p>
                <p v-else-if="appeal.conflictNote" class="appeal-note conflict">{{ appeal.conflictNote }}</p>
                <p v-else-if="appeal.status === 'withdrawn'" class="appeal-note">你于 {{ formatDate(appeal.withdrawnAt!) }} 撤回，本单已失效。</p>
              </div>

              <!-- 无待处理单时才能开新单，避免同一句重复开单 -->
              <div class="appeal-form">
                <small class="appeal-form-label">订正答案（系统将按同一标准重新逐词判定）</small>
                <textarea v-model="appealCorrection" class="appeal-input" rows="2" aria-label="逐句申诉订正答案"></textarea>
                <small class="appeal-form-label">申诉理由（连读 / 同义表达 / 标点等）</small>
                <input v-model="appealReason" class="appeal-input" placeholder="如：check in 连读被分成两个词" aria-label="逐句申诉理由" />
                <var-button block type="primary" @click="submitAppeal">发起申诉</var-button>
              </div>
            </template>
          </div>
        </section>

        <section v-if="resultAttempt.teacherFeedback" class="panel"><div class="feedback-card"><strong>教师反馈</strong><p>{{ resultAttempt.teacherFeedback }}</p></div></section>
        <var-button block type="primary" @click="startLesson(activeLesson!)">返回本次课程</var-button>
        <var-button block type="default" variant="outline" style="margin-top: 10px" @click="downloadRecords">导出练习记录</var-button>
      </div>

      <div v-else-if="view === 'teacher'" class="page">
        <header class="topbar">
          <button class="back-button" aria-label="返回课程库" @click="view = 'library'">‹</button>
          <div class="brand"><div class="brand-mark">T</div><div><h1>教师复核</h1><p>查看作答并写入反馈</p></div></div>
        </header>

        <div class="section-head"><h3>逐句申诉队列</h3><span>{{ pendingAppealCount() }} 单待处理</span></div>
        <div v-if="state.appeals.length" class="panel appeal-queue">
          <article v-for="appeal in teacherAppeals" :key="appeal.id" class="appeal-card" :data-tone="appealStatusMeta[appeal.status].tone">
            <div class="appeal-head">
              <span class="appeal-badge">{{ appealStatusMeta[appeal.status].label }}</span>
              <span class="appeal-time">{{ appealAttempt(appeal)?.lessonTitle ?? '已删除的作答' }} · 第 {{ appeal.sentenceIndex + 1 }} 句 · {{ formatDate(appeal.createdAt) }}</span>
            </div>
            <p class="appeal-source">原文：{{ appeal.source }}</p>
            <div class="appeal-grid">
              <div><small>学生原答案 · 原判 {{ appeal.originalScore }} 分</small><p>{{ appeal.originalAnswer || '（空）' }}</p></div>
              <div><small>订正答案 · 重新判定 {{ appeal.correctedScore }} 分</small><p>{{ appeal.correctedAnswer }}</p></div>
            </div>
            <p v-if="appeal.reason" class="appeal-reason">学生理由：{{ appeal.reason }}</p>

            <!-- 待处理：通过才写回单句与整课成绩；驳回必须写明原因 -->
            <template v-if="appeal.status === 'pending'">
              <textarea v-model="teacherAppealNotes[appeal.id]" class="appeal-input" rows="2" placeholder="处理意见；驳回时必须写明原因" aria-label="申诉处理意见"></textarea>
              <div class="appeal-actions">
                <var-button type="primary" size="small" @click="teacherDecideAppeal(appeal, 'approved')">通过并更新成绩</var-button>
                <var-button type="danger" size="small" variant="outline" @click="teacherDecideAppeal(appeal, 'rejected')">驳回（保留原判）</var-button>
              </div>
            </template>

            <!-- 处理期间学生撤回重提：旧单已失效，旧决定不能写回，仅可补记冲突缘由 -->
            <template v-else-if="appeal.status === 'superseded'">
              <p class="appeal-note conflict">{{ appeal.conflictNote }}</p>
              <textarea v-model="teacherAppealNotes[appeal.id]" class="appeal-input" rows="2" placeholder="可补记当时的处理意见（仅留痕，不写回成绩）" aria-label="旧单补记意见"></textarea>
              <div class="appeal-actions">
                <var-button type="default" size="small" variant="outline" @click="teacherResolveStale(appeal, 'approved')">补记“迟到通过”</var-button>
                <var-button type="default" size="small" variant="outline" @click="teacherResolveStale(appeal, 'rejected')">补记“迟到驳回”</var-button>
              </div>
            </template>

            <template v-else>
              <p v-if="appeal.status === 'approved'" class="appeal-note">已通过（{{ formatDate(appeal.decidedAt!) }}）：单句与整课成绩已更新。<template v-if="appeal.teacherNote">意见：{{ appeal.teacherNote }}</template></p>
              <p v-else-if="appeal.status === 'rejected'" class="appeal-note">已驳回（{{ formatDate(appeal.decidedAt!) }}）：{{ appeal.teacherNote }}　原结果保留。</p>
              <p v-else-if="appeal.conflictNote" class="appeal-note conflict">{{ appeal.conflictNote }}<template v-if="appeal.teacherNote">补记意见：{{ appeal.teacherNote }}</template></p>
              <p v-else-if="appeal.status === 'withdrawn'" class="appeal-note">学生于 {{ formatDate(appeal.withdrawnAt!) }} 撤回。</p>
            </template>
          </article>
        </div>
        <div v-else class="empty-state"><strong>暂无逐句申诉</strong>学生在结果页对单句判罚有异议时会在此开单。</div>

        <div class="section-head"><h3>作答与反馈</h3><span>{{ state.attempts.length }} 条</span></div>
        <div v-if="state.attempts.length" class="panel">
          <div class="dictation-label"><strong>选择一次作答</strong><span>{{ state.attempts.length }} 条</span></div>
          <var-select v-model="teacherAttemptId" placeholder="选择作答">
            <var-option v-for="attempt in state.attempts" :key="attempt.id" :label="`${attempt.lessonTitle} · ${attempt.score} 分 · ${formatDate(attempt.submittedAt)}`" :value="attempt.id" />
          </var-select>
          <template v-if="teacherAttempt">
            <div class="feedback-card">
              <strong>{{ teacherAttempt.courseTitle }}</strong>
              <p>{{ teacherAttempt.lessonTitle }} · 当前总分 {{ teacherAttempt.score }}，完成 {{ teacherAttempt.sentenceAttempts.length }} 句。</p>
              <p v-if="teacherAttempt.originalScore !== undefined && teacherAttempt.originalScore !== teacherAttempt.score" class="score-version">
                申诉处理前整课 {{ teacherAttempt.originalScore }} 分 → 处理后 {{ teacherAttempt.score }} 分
              </p>
              <ul v-if="teacherAttempt.sentenceAttempts.some((item) => item.originalScore !== undefined && item.originalScore !== item.score)" class="sentence-diff">
                <li v-for="(item, idx) in teacherAttempt.sentenceAttempts" :key="item.sentenceId">
                  <template v-if="item.originalScore !== undefined && item.originalScore !== item.score">第 {{ idx + 1 }} 句：{{ item.originalScore }} → {{ item.score }} 分</template>
                </li>
              </ul>
            </div>
            <div class="teacher-editor">
              <textarea v-model="teacherDraft" placeholder="给学生一条具体、可执行的反馈..." aria-label="教师反馈"></textarea>
              <var-button block type="primary" style="margin-top: 10px" @click="saveTeacherFeedback">保存反馈</var-button>
            </div>
          </template>
        </div>
        <div v-else class="empty-state"><strong>暂无学生作答</strong>学习端提交听写后，这里会出现练习记录。</div>
      </div>

      <div v-if="toast" style="position: fixed; z-index: 30; left: 50%; bottom: 28px; transform: translateX(-50%); padding: 11px 16px; border-radius: 12px; background: #17233d; color: white; font-size: .78rem; box-shadow: 0 10px 30px rgb(0 0 0 / .2)">{{ toast }}</div>
    </div>
  </var-app>
</template>
