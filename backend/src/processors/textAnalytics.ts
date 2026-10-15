import type { TextAnalyticsParams } from '@queuepilot/shared';
import { fileExtension } from '@queuepilot/shared';
import { NonRetryableJobError } from '../lib/errors.js';
import { decodeText, round } from './text.js';
import type { ProcessorInput, ProcessorOutput } from './types.js';

// Common English words that carry little meaning on their own.
const STOP_WORDS = new Set(
  `a about above after again against all also am an and any are aren't as at be because been before being below between
both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each few for from further
had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's i i'd
i'll i'm i've if in into is isn't it it's its itself just let's may me might more most must mustn't my myself no nor not
now of off on once one only or other ought our ours ourselves out over own same shall shan't she she'd she'll she's should
shouldn't so some such than that that's the their theirs them themselves then there there's these they they'd they'll
they're they've this those through to too under until up upon us very was wasn't we we'd we'll we're we've were weren't
what what's when when's where where's which while who who's whom why why's will with won't would wouldn't yes yet you
you'd you'll you're you've your yours yourself yourselves rather instead within without however therefore thus`
    .split(/\s+/)
    .filter(Boolean),
);

const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

/** Removes Markdown syntax so it is not counted as words. */
export function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ') // fenced code blocks
    .replace(/`[^`\n]*`/g, ' ') // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links -> link text
    .replace(/^\s{0,3}#{1,6}\s*/gm, '') // headings
    .replace(/^\s*[-*+]\s+/gm, '') // bullet markers
    .replace(/^\s*\d+\.\s+/gm, '') // numbered list markers
    .replace(/^\s*>\s?/gm, '') // block quotes
    .replace(/(\*\*|__|\*|_|~~)/g, '') // emphasis
    .replace(/<[^>]+>/g, ' '); // inline HTML
}

export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[\p{Lu}\p{N}"'(])/u)
    .map((s) => s.trim())
    .filter((s) => (s.match(WORD) ?? []).length > 0);
}

export function textAnalytics({ body, fileName, params }: ProcessorInput<TextAnalyticsParams>): ProcessorOutput {
  const raw = decodeText(body);
  const isMarkdown = fileExtension(fileName) === '.md';
  const text = isMarkdown ? stripMarkdown(raw) : raw;

  const words = text.match(WORD) ?? [];
  if (words.length === 0) throw new NonRetryableJobError('The file contains no words to analyze.', 'NO_TEXT');

  const sentences = splitSentences(text);
  const paragraphs = text.split(/\n\s*\n/).filter((p) => (p.match(WORD) ?? []).length > 0).length;
  const lower = words.map((w) => w.toLowerCase().replace(/’/g, "'"));
  const uniqueWords = new Set(lower).size;

  const termCounts = new Map<string, number>();
  for (const w of lower) {
    if (w.length < 3 || STOP_WORDS.has(w) || /^\d+$/.test(w)) continue;
    termCounts.set(w, (termCounts.get(w) ?? 0) + 1);
  }
  const topTerms = [...termCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, params.topN)
    .map(([term, count]) => ({ term, count, per1000Words: round((count / words.length) * 1000, 1) }));

  const sentenceWordCounts = sentences.map((s) => (s.match(WORD) ?? []).length);
  const longSentences = sentences
    .map((s, i) => ({ index: i + 1, words: sentenceWordCounts[i]!, text: s.length > 240 ? `${s.slice(0, 237)}...` : s }))
    .filter((s) => s.words > params.longSentenceWords)
    .sort((a, b) => b.words - a.words)
    .slice(0, 10);

  const readingTimeSeconds = Math.round((words.length / params.wordsPerMinute) * 60);
  const result = {
    jobType: 'text.analytics',
    fileName,
    format: isMarkdown ? 'markdown' : 'plain-text',
    characterCount: raw.length,
    wordCount: words.length,
    uniqueWordCount: uniqueWords,
    lexicalDiversity: round(uniqueWords / words.length, 3),
    sentenceCount: sentences.length,
    paragraphCount: paragraphs,
    averageWordsPerSentence: sentences.length ? round(words.length / sentences.length, 1) : 0,
    readingTime: {
      wordsPerMinute: params.wordsPerMinute,
      seconds: readingTimeSeconds,
      minutes: Math.max(1, Math.ceil(readingTimeSeconds / 60)),
    },
    topTerms,
    longSentenceThreshold: params.longSentenceWords,
    longSentenceCount: sentenceWordCounts.filter((n) => n > params.longSentenceWords).length,
    longSentences,
    generatedAt: new Date().toISOString(),
  };

  return {
    files: [{ name: 'result.json', contentType: 'application/json', body: JSON.stringify(result, null, 2) }],
    summary: {
      words: result.wordCount,
      sentences: result.sentenceCount,
      readingMinutes: result.readingTime.minutes,
      topTerms: topTerms.slice(0, 5).map((t) => t.term),
      longSentences: result.longSentenceCount,
    },
  };
}
