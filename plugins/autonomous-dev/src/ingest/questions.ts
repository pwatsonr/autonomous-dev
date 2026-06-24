/**
 * Blocking-question queue (ONBOARD Phase 1 — #587, AC3).
 *
 * When ingestion hits an ambiguity it can't resolve ("is repo X in project Y?",
 * "which standard is authoritative?"), it enqueues a Question; that repo is
 * BLOCKED (its ingestion pauses) until the question is answered. Persisted as a
 * JSON file via injected IO (no native dep), mirroring the ownership store.
 * The portal answer-UI is Phase 3; Phase 1 exposes the store + a CLI.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface Question {
  id: string;
  repoId: string;
  question: string;
  options: string[];
  status: 'pending' | 'answered';
  answer?: string;
}

export interface QuestionStoreIO {
  homedir(): string;
  readFile(filePath: string): string | undefined;
  writeFile(filePath: string, data: string): void;
}

export const defaultQuestionIO: QuestionStoreIO = {
  homedir: () => process.env.HOME ?? os.homedir(),
  readFile: (filePath) => (fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : undefined),
  writeFile: (filePath, data) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, data, 'utf-8');
    fs.renameSync(tmp, filePath);
  },
};

export function questionsPath(io: QuestionStoreIO = defaultQuestionIO): string {
  return path.join(io.homedir(), '.autonomous-dev', 'ingest', 'questions.json');
}

export function loadQuestions(io: QuestionStoreIO = defaultQuestionIO): Question[] {
  const raw = io.readFile(questionsPath(io));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Question[]) : [];
  } catch {
    return [];
  }
}

function saveQuestions(qs: Question[], io: QuestionStoreIO): void {
  io.writeFile(questionsPath(io), `${JSON.stringify(qs, null, 2)}\n`);
}

/** Enqueue a pending question (idempotent by id — re-enqueue replaces it). */
export function enqueueQuestion(
  q: { id: string; repoId: string; question: string; options: string[] },
  io: QuestionStoreIO = defaultQuestionIO,
): Question {
  if (!q.id.trim()) throw new Error('Question id is required.');
  if (!q.repoId.trim()) throw new Error('Question repoId is required.');
  if (q.options.length === 0) throw new Error('Question needs at least one option.');
  const qs = loadQuestions(io);
  const question: Question = { id: q.id, repoId: q.repoId, question: q.question, options: q.options, status: 'pending' };
  const idx = qs.findIndex((x) => x.id === q.id);
  if (idx >= 0) qs[idx] = question;
  else qs.push(question);
  saveQuestions(qs, io);
  return question;
}

export function listQuestions(
  io: QuestionStoreIO = defaultQuestionIO,
  filter?: { status?: 'pending' | 'answered'; repoId?: string },
): Question[] {
  let qs = loadQuestions(io);
  if (filter?.status) qs = qs.filter((q) => q.status === filter.status);
  if (filter?.repoId) qs = qs.filter((q) => q.repoId === filter.repoId);
  return qs;
}

/** Answer a question; the choice must be one of its options. Resolving it unblocks the repo. */
export function answerQuestion(
  id: string,
  choice: string,
  io: QuestionStoreIO = defaultQuestionIO,
): Question {
  const qs = loadQuestions(io);
  const q = qs.find((x) => x.id === id);
  if (!q) throw new Error(`Unknown question "${id}".`);
  if (!q.options.includes(choice)) {
    throw new Error(`Invalid answer "${choice}"; expected one of: ${q.options.join(', ')}.`);
  }
  q.status = 'answered';
  q.answer = choice;
  saveQuestions(qs, io);
  return q;
}

/** A repo is BLOCKED while it has any pending question. */
export function isRepoBlocked(repoId: string, io: QuestionStoreIO = defaultQuestionIO): boolean {
  return loadQuestions(io).some((q) => q.repoId === repoId && q.status === 'pending');
}
