export type ErrorCategory = 'unclassified' | 'spelling' | 'omitted' | 'extra' | 'punctuation' | 'grammar';
export type PracticeView = 'library' | 'practice' | 'result' | 'teacher';
export type ThemeMode = 'light' | 'dark';
export type AppealStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';
export type AppealDecision = 'approved' | 'rejected';

export interface Sentence {
  id: string;
  text: string;
  translation: string;
  note: string;
}

export interface Lesson {
  id: string;
  courseId: string;
  title: string;
  subtitle: string;
  level: string;
  estimatedMinutes: number;
  downloaded: boolean;
  sentences: Sentence[];
}

export interface Course {
  id: string;
  title: string;
  description: string;
  level: string;
  accent: string;
  lessons: Lesson[];
}

export interface TokenResult {
  index: number;
  expected: string;
  actual: string;
  correct: boolean;
  category: ErrorCategory;
  reason: string;
}

export interface SentenceAttempt {
  sentenceId: string;
  source: string;
  answer: string;
  tokens: TokenResult[];
  score: number;
}

export interface PracticeAttempt {
  id: string;
  lessonId: string;
  lessonTitle: string;
  courseTitle: string;
  submittedAt: string;
  score: number;
  sentenceAttempts: SentenceAttempt[];
  teacherFeedback: string;
}

export interface SentenceAppeal {
  id: string;
  attemptId: string;
  sentenceId: string;
  // 处理前快照（before）：学生开单时该句的答案、逐词结果与单句得分
  originalAnswer: string;
  originalScore: number;
  originalTokens: TokenResult[];
  // 学生订正（after 提案）：主张应被采纳的答案与申诉理由
  correctedAnswer: string;
  appealReason: string;
  // 处理状态
  status: AppealStatus;
  teacherNote: string;
  processedAt: string | null;
  createdAt: string;
  // 版本控制：撤回重提时 +1，用于乐观锁冲突检测
  version: number;
  // 冲突标记：处理期间出现新订正、旧决定无法写回成绩时置 true
  conflict: boolean;
  conflictReason: string;
}

export interface LessonProgress {
  answers: Record<string, string>;
  activeSentenceId: string;
  updatedAt: string;
}

export interface PersistedState {
  schemaVersion: 1;
  courses: Course[];
  attempts: PracticeAttempt[];
  appeals: SentenceAppeal[];
  progress: Record<string, LessonProgress>;
  activeLessonId: string;
  activeSentenceId: string;
  theme: ThemeMode;
  fontScale: number;
  role: 'learner' | 'teacher';
}

export interface TextSegment {
  index: number;
  display: string;
  normalized: string;
}
