export type ErrorCategory = 'unclassified' | 'spelling' | 'omitted' | 'extra' | 'punctuation' | 'grammar';
export type PracticeView = 'library' | 'practice' | 'result' | 'teacher';
export type ThemeMode = 'light' | 'dark';

/**
 * 逐句申诉状态机：
 * - pending：学生已提交，等待教师处理（同一句同时只允许一单）
 * - approved：教师通过，订正已写回单句与整课成绩
 * - rejected：教师驳回，原结果保留，teacherNote 写明原因
 * - withdrawn：学生在处理前主动撤回，旧单随即失效
 * - superseded：撤回后用新订重重提，旧单被新单取代
 * - conflict：处理期间该句已出现更新订正，旧决定不写回成绩，只记录冲突缘由
 */
export type AppealStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'superseded' | 'conflict';
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
  /** 申诉通过后才写入的“处理前版本”，用于结果页与导出核对。 */
  originalAnswer?: string;
  originalScore?: number;
  originalTokens?: TokenResult[];
  /** 最后一次把成绩改写为本版本的申诉单。 */
  adjustedByAppealId?: string;
}

export interface PracticeAttempt {
  id: string;
  lessonId: string;
  lessonTitle: string;
  courseTitle: string;
  submittedAt: string;
  score: number;
  /** 整课原始总分，申诉通过更新分数后仍可核对处理前版本。 */
  originalScore?: number;
  sentenceAttempts: SentenceAttempt[];
  teacherFeedback: string;
}

/** 逐句申诉单：冻结发起时的原判快照与学生订正快照，处理前后版本均可核对。 */
export interface SentenceAppeal {
  id: string;
  attemptId: string;
  sentenceId: string;
  /** 句序号从 0 开始，教师页直接展示“第 N 句”。 */
  sentenceIndex: number;
  source: string;
  /** 学生申诉理由，如连读、同义表达被系统误判。 */
  reason: string;
  status: AppealStatus;
  createdAt: string;
  /** 发起申诉时冻结的原答案、原判分与逐词结果。 */
  originalAnswer: string;
  originalScore: number;
  originalTokens: TokenResult[];
  /** 学生提交的订正答案及其重新判定结果。 */
  correctedAnswer: string;
  correctedScore: number;
  correctedTokens: TokenResult[];
  decidedAt?: string;
  /** 教师处理意见；驳回时为必填的驳回原因。 */
  teacherNote?: string;
  withdrawnAt?: string;
  /** 撤回重提后，指向取代本单的新申诉单。 */
  supersededByAppealId?: string;
  /** 冲突缘由：旧决定为何没有写回成绩。 */
  conflictNote?: string;
}

export interface LessonProgress {
  answers: Record<string, string>;
  activeSentenceId: string;
  updatedAt: string;
}

export interface PersistedState {
  schemaVersion: 2;
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
