const express = require('express');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');
const { buildDocxBuffer } = require('./docx-builder');

require('dotenv').config();

const app = express();

const PORT = Number(process.env.PORT || 3001);
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE || 40 * 1024 * 1024);
const GENERATED_DIR = path.resolve(__dirname, 'generated');

const KIMI_BASE_URL = process.env.KIMI_BASE_URL || 'https://api.moonshot.cn/v1';
const KIMI_METADATA_MODEL = process.env.KIMI_METADATA_MODEL || process.env.KIMI_MODEL || 'moonshot-v1-8k';
const KIMI_WRITING_MODEL = process.env.KIMI_WRITING_MODEL || process.env.KIMI_CHAT_MODEL || process.env.KIMI_MODEL || 'moonshot-v1-32k';
const KIMI_REQUEST_TIMEOUT_MS = Number(process.env.KIMI_REQUEST_TIMEOUT_MS || 90000);
const KIMI_TOTAL_TIMEOUT_MS = Number(process.env.KIMI_TOTAL_TIMEOUT_MS || 300000);
const KIMI_MAX_RETRIES = Number(process.env.KIMI_MAX_RETRIES || 4);
const KIMI_RETRY_BASE_MS = Number(process.env.KIMI_RETRY_BASE_MS || 4000);
const KIMI_RETRY_MAX_MS = Number(process.env.KIMI_RETRY_MAX_MS || 20000);
const KIMI_ALLOW_LOCAL_FALLBACK = String(process.env.KIMI_ALLOW_LOCAL_FALLBACK || 'false').toLowerCase() === 'true';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE }
});

const progressStore = new Map();
const resultStore = new Map();

const HEADING_ALIASES = {
  abstract: ['ABSTRACT'],
  introduction: ['INTRODUCTION', 'BACKGROUND', 'PRELIMINARIES', 'PRELIMINARY'],
  methods: ['SYSTEMMODEL', 'SYSTEMMODELANDPROBLEMFORMULATION', 'PROBLEMFORMULATION', 'METHOD', 'METHODS', 'METHODOLOGY', 'FRAMEWORK', 'ALGORITHM', 'OPTIMIZATION', 'PROPOSEDMETHOD', 'DESIGN'],
  experiments: ['EXPERIMENT', 'EXPERIMENTS', 'RESULT', 'RESULTS', 'NUMERICALRESULTS', 'SIMULATION', 'SIMULATIONS', 'SIMULATIONRESULTS', 'EVALUATION', 'PERFORMANCEEVALUATION'],
  conclusion: ['CONCLUSION', 'CONCLUSIONS', 'DISCUSSION', 'CONCLUSIONANDFUTUREWORK', 'FUTUREWORK'],
  references: ['REFERENCE', 'REFERENCES', 'BIBLIOGRAPHY']
};

const STOPWORDS = new Set([
  'the', 'and', 'that', 'with', 'from', 'this', 'their', 'which', 'have', 'using', 'used', 'into', 'such', 'also',
  'these', 'those', 'paper', 'proposed', 'based', 'system', 'systems', 'method', 'methods', 'results', 'result',
  'analysis', 'model', 'models', 'problem', 'network', 'wireless', 'communication', 'communications', 'however',
  'research', 'study', 'design', 'joint', 'edge', 'federated', 'sensing', 'learning'
]);

fs.mkdirSync(GENERATED_DIR, { recursive: true });

app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/downloads', express.static(GENERATED_DIR));

function normalizeWhitespace(value) {
  return String(value || '')
    .replace(/\r/g, '\n')
    .replace(/\u0000/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function resolveKimiApiKey(overrideKey) {
  return normalizeWhitespace(overrideKey || '');
}

function truncate(value, maxLength) {
  const text = String(value || '').trim();
  if (!text || text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function slugify(value) {
  const normalized = String(value || '')
    .normalize('NFKD')
    .replace(/[^\w\s\u4e00-\u9fff-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 120);
  return normalized || 'paper-draft';
}

function alphaTokens(value) {
  return String(value || '').toLowerCase().match(/[a-z]{3,}/g) || [];
}

function compactHeading(line) {
  return String(line || '')
    .replace(/^[\dIVXLCM.A()\-]+\s+/i, '')
    .replace(/[-:]/g, '')
    .replace(/\s+/g, '')
    .replace(/[^A-Za-z]/g, '')
    .toUpperCase();
}

function looksLikeHeadingLine(line) {
  const trimmed = normalizeWhitespace(line);
  if (!trimmed) {
    return false;
  }
  if (/^(abstract|index\s*terms|keywords)\b/i.test(trimmed)) {
    return true;
  }
  const compact = compactHeading(trimmed);
  if (compact === 'INDEXTERMS' || compact === 'KEYWORDS') {
    return true;
  }
  return Object.values(HEADING_ALIASES).some((aliases) => aliases.some((alias) => compact === alias || compact.endsWith(alias)));
}

function shouldJoinPdfLines(previousLine, currentLine) {
  const previous = normalizeWhitespace(previousLine);
  const current = normalizeWhitespace(currentLine);
  if (!previous || !current) {
    return false;
  }
  if (looksLikeHeadingLine(previous) || looksLikeHeadingLine(current)) {
    return false;
  }
  if (/^\d+$/.test(previous) || /^\d+$/.test(current)) {
    return false;
  }
  if (/^[,.;:%)\]]/.test(current)) {
    return true;
  }
  if (/^[a-z(]/.test(current) && !/[.!?。！？:：]$/.test(previous)) {
    return true;
  }
  if (/[A-Za-z0-9,]$/.test(previous) && /^[A-Za-z(]/.test(current) && !/[.!?;:]$/.test(previous)) {
    return true;
  }
  if (/[\u4e00-\u9fff]$/.test(previous) && /^[\u4e00-\u9fff]/.test(current)) {
    return true;
  }
  return false;
}

function cleanPdfText(rawText) {
  const sourceLines = String(rawText || '')
    .replace(/\r/g, '\n')
    .replace(/\u00ad/g, '')
    .replace(/([A-Za-z])-\n([a-z])/g, '$1$2')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .split('\n');

  const mergedLines = [];
  for (const rawLine of sourceLines) {
    const line = normalizeWhitespace(rawLine);
    if (!line) {
      if (mergedLines.length && mergedLines[mergedLines.length - 1] !== '') {
        mergedLines.push('');
      }
      continue;
    }
    if (!mergedLines.length || mergedLines[mergedLines.length - 1] === '') {
      mergedLines.push(line);
      continue;
    }
    const lastIndex = mergedLines.length - 1;
    if (shouldJoinPdfLines(mergedLines[lastIndex], line)) {
      mergedLines[lastIndex] = `${mergedLines[lastIndex]} ${line}`.replace(/\s+/g, ' ').trim();
    } else {
      mergedLines.push(line);
    }
  }
  return normalizeWhitespace(mergedLines.join('\n'));
}

function buildHeaderLines(rawText) {
  const beforeAbstract = String(rawText || '').split(/abstract/i)[0] || '';
  return beforeAbstract
    .split('\n')
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean)
    .slice(0, 32);
}

function detectHeading(line) {
  const trimmed = normalizeWhitespace(line);
  if (!trimmed) {
    return null;
  }
  if (/^abstract\b/i.test(trimmed)) {
    return { key: 'abstract', inline: trimmed.replace(/^abstract\s*[-:]?\s*/i, '').trim() };
  }
  if (/^(index\s*terms|keywords)\b/i.test(trimmed)) {
    return { key: 'indexTerms', inline: trimmed.replace(/^(index\s*terms|keywords)\s*[-:]?\s*/i, '').trim() };
  }
  const compact = compactHeading(trimmed);
  for (const [key, aliases] of Object.entries(HEADING_ALIASES)) {
    if (aliases.some((alias) => compact === alias || compact.endsWith(alias))) {
      return { key, inline: '' };
    }
  }
  return null;
}

function parseSections(cleanText) {
  const sections = { abstract: '', introduction: '', methods: '', experiments: '', conclusion: '', indexTerms: '' };
  const lines = String(cleanText || '').split('\n').map(normalizeWhitespace).filter(Boolean);
  let current = '';
  for (const line of lines) {
    const heading = detectHeading(line);
    if (heading) {
      if (heading.key === 'references') {
        break;
      }
      current = sections[heading.key] !== undefined ? heading.key : '';
      if (current && heading.inline) {
        sections[current] = `${sections[current]}\n${heading.inline}`.trim();
      }
      continue;
    }
    if (current && sections[current] !== undefined) {
      sections[current] = `${sections[current]}\n${line}`.trim();
    }
  }
  return sections;
}

function detectDocumentType({ originalName, rawText, cleanText, sections, pages }) {
  const fileName = normalizeWhitespace(originalName).toLowerCase();
  const header = buildHeaderLines(rawText).slice(0, 24).join(' ').toLowerCase();
  const text = String(cleanText || rawText || '');
  const lowerText = text.toLowerCase();
  let presentationScore = 0;
  const reasons = [];

  const addSignal = (condition, score, reason) => {
    if (condition) {
      presentationScore += score;
      reasons.push(reason);
    }
  };

  addSignal(/\bslides?\b|presentation|ppt|汇报|讲稿|报告/.test(fileName), 3, '文件名更像汇报稿或幻灯片');
  addSignal(/论文汇报|汇报稿|slides?|presentation|报告人|主讲/.test(header), 4, '首页标题含汇报/幻灯片信号');
  addSignal(/--\s*\d+\s*of\s*\d+\s*--/i.test(text), 3, '正文包含幻灯片页码样式');
  addSignal(/\bfig\.\s*\d+\s*from the paper\b/i.test(text), 2, '正文包含 from the paper 标注');
  addSignal(/\d+\s*页汇报稿/.test(text), 4, '正文明确写明汇报稿');
  addSignal(/\b(agenda|outline|contents|thanks|q&a)\b/i.test(header), 2, '首页更像汇报目录或结束页');
  addSignal(pages > 0 && pages <= 25 && !sections.abstract && !sections.introduction, 1, '缺少论文常见章节');

  if (/10\.\d{4,9}\//i.test(text)) {
    presentationScore -= 2;
  }
  if (sections.abstract) {
    presentationScore -= 1;
  }
  if (sections.introduction) {
    presentationScore -= 1;
  }
  if (/references\b/i.test(lowerText)) {
    presentationScore -= 1;
  }

  return {
    kind: presentationScore >= 5 ? 'presentation' : 'paper',
    confidence: Math.max(0, Math.min(0.99, presentationScore / 10)),
    reasons: Array.from(new Set(reasons))
  };
}

function cleanSectionNoise(text, kind) {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return '';
  }
  if (kind === 'abstract') {
    return normalizeWhitespace(
      normalized
        .split(/\b(index\s*terms|keywords|introduction)\b/i)[0]
        .split(/\b(received|accepted|copyright|digital object identifier)\b/i)[0]
    );
  }
  return normalized;
}

function normalizeTitleForMatch(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
}

function scoreTitleCandidate(candidateTitle, queryTitle) {
  const candidate = normalizeTitleForMatch(candidateTitle);
  const query = normalizeTitleForMatch(queryTitle);
  if (!candidate || !query) {
    return -100;
  }
  let score = 0;
  if (candidate === query) {
    score += 100;
  }
  if (candidate.includes(query) || query.includes(candidate)) {
    score += 40;
  }
  const queryTokens = new Set(alphaTokens(queryTitle));
  score += alphaTokens(candidateTitle).filter((token) => queryTokens.has(token)).length * 8;
  return score - Math.abs(candidate.length - query.length) / 10;
}

function isLikelyAuthorLine(line, title) {
  const cleaned = normalizeWhitespace(line);
  if (!cleaned || cleaned.length < 8 || cleaned.length > 250) {
    return false;
  }
  if (/university|department|laboratory|school|institute|email|@|received|accepted|copyright|doi|transactions|journal/i.test(cleaned)) {
    return false;
  }
  if (title && cleaned.includes(normalizeWhitespace(title))) {
    return false;
  }
  const separators = cleaned.match(/,| and |&/gi) || [];
  const names = cleaned.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z.'-]+){0,2}\b/g) || [];
  return names.length >= 2 || (names.length >= 1 && separators.length >= 1);
}

function cleanAuthorLine(line) {
  return normalizeWhitespace(
    String(line || '')
      .replace(/\bcorresponding author\b/gi, '')
      .replace(/\b(senior )?member,\s*IEEE\b/gi, '')
      .replace(/\bfellow,\s*IEEE\b/gi, '')
      .replace(/\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi, '')
      .replace(/\(\s*\d+\s*\)/g, ' ')
      .replace(/\d+/g, ' ')
      .replace(/\s+,/g, ',')
      .replace(/^[,;\s]+|[,;\s]+$/g, '')
  );
}

function extractTitleFromText(rawText) {
  const candidates = buildHeaderLines(rawText).filter((line) => {
    if (line.length < 12 || line.length > 260) {
      return false;
    }
    if (/abstract|keywords|index terms|doi|received|accepted|transactions|journal|conference|proceedings|copyright/i.test(line)) {
      return false;
    }
    if (isLikelyAuthorLine(line, '')) {
      return false;
    }
    return true;
  });
  return candidates.length ? truncate(candidates.slice(0, 3).join(' '), 240) : '';
}

function pickTitle(pdfInfo, originalName, rawText) {
  const metadataTitle = normalizeWhitespace(pdfInfo?.Title || '');
  const fileTitle = normalizeWhitespace(String(originalName || '').replace(/\.pdf$/i, ''));
  const textTitle = extractTitleFromText(rawText);
  if (metadataTitle && metadataTitle.toLowerCase() !== 'untitled') {
    return truncate(metadataTitle, 240);
  }
  return textTitle || fileTitle;
}

function normalizeDoiValue(value) {
  const match = normalizeWhitespace(value).match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i);
  return match ? match[0] : '';
}

function extractDoi(rawText, info) {
  const fromInfo = normalizeDoiValue(info?.DOI || '');
  if (fromInfo) {
    return fromInfo;
  }
  const fromSubject = normalizeDoiValue(info?.Subject || '');
  if (fromSubject) {
    return fromSubject;
  }
  const matches = String(rawText || '').match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/ig) || [];
  const preferred = matches.find((item) => /^10\.1109\//i.test(item)) || matches[0];
  return preferred || '';
}

function formatDoiAuthors(authors) {
  if (!Array.isArray(authors)) {
    return '';
  }
  return authors
    .map((author) => normalizeWhitespace([author?.given, author?.family].filter(Boolean).join(' ')))
    .filter(Boolean)
    .slice(0, 12)
    .join(', ');
}

async function lookupDoiMetadata(doi) {
  const cleanDoi = normalizeDoiValue(doi);
  if (!cleanDoi) {
    return null;
  }
  try {
    const response = await axios.get(`https://api.crossref.org/works/${encodeURIComponent(cleanDoi)}`, {
      timeout: 10000,
      headers: { 'User-Agent': 'paper-to-wechat-workbench/1.0 metadata' }
    });
    const message = response.data?.message || {};
    return {
      title: normalizeWhitespace(Array.isArray(message.title) ? message.title[0] : message.title),
      authors: formatDoiAuthors(message.author),
      journal: normalizeWhitespace(Array.isArray(message['container-title']) ? message['container-title'][0] : message['container-title']),
      doi: cleanDoi
    };
  } catch (_error) {
    return null;
  }
}

async function lookupMetadataByTitle(title) {
  const queryTitle = normalizeWhitespace(title);
  if (!queryTitle || queryTitle.length < 12) {
    return null;
  }
  try {
    const response = await axios.get('https://api.crossref.org/works', {
      params: { 'query.title': queryTitle, rows: 5 },
      timeout: 12000,
      headers: { 'User-Agent': 'paper-to-wechat-workbench/1.0 metadata' }
    });
    const items = Array.isArray(response.data?.message?.items) ? response.data.message.items : [];
    const best = items
      .map((item) => {
        const itemTitle = normalizeWhitespace(Array.isArray(item.title) ? item.title[0] : item.title);
        return {
          title: itemTitle,
          score: scoreTitleCandidate(itemTitle, queryTitle),
          journal: normalizeWhitespace(Array.isArray(item['container-title']) ? item['container-title'][0] : item['container-title']),
          authors: formatDoiAuthors(item.author),
          doi: normalizeDoiValue(item.DOI || '')
        };
      })
      .sort((a, b) => b.score - a.score)[0];
    return best && best.score >= 35 ? best : null;
  } catch (_error) {
    return null;
  }
}

function cleanJournalCandidate(value) {
  return normalizeWhitespace(
    String(value || '')
      .replace(/^published in[:\s-]*/i, '')
      .replace(/^accepted (for publication )?in[:\s-]*/i, '')
      .replace(/[;，,]\s*PP\s*;?.*$/i, '')
      .replace(/\b(vol|volume|no|number|pp|pages)\b.*$/i, '')
      .replace(/\bdoi[:\s].*$/i, '')
      .replace(/\b(received|accepted|copyright|current version|date of publication).*/i, '')
      .replace(/[;，,\s]+$/g, '')
  );
}

function scoreJournalCandidate(value) {
  const text = cleanJournalCandidate(value);
  if (!text || text.length < 8 || text.length > 180) {
    return -100;
  }
  if (/university|department|laboratory|school|institute|author|email|copyright|received/i.test(text)) {
    return -100;
  }
  let score = 0;
  if (/ieee|acm|springer|elsevier|wiley|nature|science/i.test(text)) {
    score += 4;
  }
  if (/transactions on|journal|letters|magazine|communications|networks|proceedings|conference|symposium/i.test(text)) {
    score += 6;
  }
  return score;
}

function isSuspiciousAuthorValue(value) {
  const text = normalizeWhitespace(value);
  return !text || /openai|codex|chatgpt|gpt[-\s]?\d|assistant/i.test(text);
}

function looksLikeTitleFragment(value, title) {
  const authorNorm = normalizeTitleForMatch(value);
  const titleNorm = normalizeTitleForMatch(title);
  if (!authorNorm || !titleNorm) {
    return false;
  }
  return titleNorm.includes(authorNorm) || authorNorm.includes(titleNorm);
}

function isInvalidAuthorCandidate(value, title) {
  return isSuspiciousAuthorValue(value) || looksLikeTitleFragment(value, title);
}

function isSuspiciousJournalValue(value) {
  const text = cleanJournalCandidate(value);
  return !text || /openai|codex|chatgpt/i.test(text) || scoreJournalCandidate(text) <= 0;
}

function firstValidValue(candidates, isInvalid) {
  for (const candidate of candidates) {
    const text = normalizeWhitespace(candidate);
    if (!text) {
      continue;
    }
    if (typeof isInvalid === 'function' && isInvalid(text)) {
      continue;
    }
    return text;
  }
  return '';
}

function extractAuthors(rawText, metadataAuthor, title, doiMetadata) {
  if (doiMetadata?.authors) {
    return doiMetadata.authors;
  }
  if (metadataAuthor && !isSuspiciousAuthorValue(metadataAuthor)) {
    return cleanAuthorLine(metadataAuthor);
  }
  const lines = buildHeaderLines(rawText);
  const abstractIndex = lines.findIndex((line) => /^abstract\b/i.test(line));
  const searchLines = abstractIndex >= 0 ? lines.slice(0, abstractIndex) : lines.slice(0, 12);
  const titleIndex = lines.findIndex((line) => normalizeWhitespace(line) === normalizeWhitespace(title));
  if (titleIndex >= 0) {
    const titleWindow = lines.slice(titleIndex + 1, titleIndex + 5).join(', ');
    if (isLikelyAuthorLine(titleWindow, title)) {
      return cleanAuthorLine(titleWindow);
    }
  }
  const authorStart = searchLines.findIndex((line) => isLikelyAuthorLine(line, title));
  if (authorStart < 0) {
    return '';
  }
  const authorParts = [searchLines[authorStart]];
  for (let index = authorStart + 1; index < Math.min(searchLines.length, authorStart + 3); index += 1) {
    const line = searchLines[index];
    if (!line || /^abstract\b/i.test(line) || looksLikeHeadingLine(line)) {
      break;
    }
    if (isLikelyAuthorLine(line, title) || /\b(member|fellow),\s*IEEE\b/i.test(line) || /\band\b/i.test(line)) {
      authorParts.push(line);
      continue;
    }
    break;
  }
  return cleanAuthorLine(authorParts.join(', '));
}

function extractJournal(rawText, info, doiMetadata) {
  if (doiMetadata?.journal) {
    return doiMetadata.journal;
  }
  const candidates = [];
  if (normalizeWhitespace(info?.Subject || '')) {
    candidates.push(info.Subject);
  }
  const lines = buildHeaderLines(rawText).slice(0, 20);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const merged = [line, lines[index + 1], lines[index + 2]].filter(Boolean).join(' ');
    if (/ieee|acm|springer|elsevier|wiley|nature|science/i.test(line) || /transactions on|journal|letters|magazine|conference|proceedings|symposium/i.test(line)) {
      candidates.push(line);
      candidates.push(merged);
    }
  }
  const best = candidates
    .map((candidate) => cleanJournalCandidate(candidate))
    .filter(Boolean)
    .map((candidate) => ({ candidate, score: scoreJournalCandidate(candidate) }))
    .sort((a, b) => b.score - a.score)[0];
  return best && best.score > 0 ? best.candidate : '';
}

function scoreAuthorOverlap(candidate, reference) {
  const candidateTokens = new Set(alphaTokens(candidate));
  const referenceTokens = new Set(alphaTokens(reference));
  if (!candidateTokens.size || !referenceTokens.size) {
    return 0;
  }
  let overlap = 0;
  for (const token of candidateTokens) {
    if (referenceTokens.has(token)) {
      overlap += 1;
    }
  }
  return overlap;
}

function resolvePaperMetadata({ localTitle, localAuthors, localJournal, localDoi, doiMetadata, titleMetadata, llmMetadata }) {
  const strongTitleLookup = titleMetadata?.title && scoreTitleCandidate(titleMetadata.title, localTitle) >= 70;
  const llmTitleAligned = llmMetadata?.title && scoreTitleCandidate(llmMetadata.title, localTitle) >= 85;
  const llmAuthorAligned = llmMetadata?.authors && !isInvalidAuthorCandidate(llmMetadata.authors, localTitle) && (!localAuthors || scoreAuthorOverlap(llmMetadata.authors, localAuthors) >= 1);

  return {
    title: firstValidValue([doiMetadata?.title, strongTitleLookup ? titleMetadata?.title : '', localTitle, llmTitleAligned ? llmMetadata?.title : '']),
    authors: cleanAuthorLine(firstValidValue([llmAuthorAligned ? llmMetadata?.authors : '', doiMetadata?.authors, localAuthors, strongTitleLookup ? titleMetadata?.authors : ''], (value) => isInvalidAuthorCandidate(value, localTitle))),
    journal: firstValidValue([doiMetadata?.journal, localJournal, strongTitleLookup ? titleMetadata?.journal : '', llmMetadata?.journal], isSuspiciousJournalValue),
    doi: firstValidValue([normalizeDoiValue(localDoi), normalizeDoiValue(doiMetadata?.doi), strongTitleLookup ? normalizeDoiValue(titleMetadata?.doi) : '', llmTitleAligned ? normalizeDoiValue(llmMetadata?.doi) : ''])
  };
}

function tryParseJson(raw) {
  const text = String(raw || '').trim();
  if (!text) {
    return null;
  }

  const tryCandidate = (candidate) => {
    const source = String(candidate || '').trim();
    if (!source) {
      return null;
    }
    try {
      return JSON.parse(source);
    } catch (_error) {
      return null;
    }
  };

  try {
    return JSON.parse(text);
  } catch (_error) {
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch) {
      const parsedFence = tryCandidate(fenceMatch[1]);
      if (parsedFence) {
        return parsedFence;
      }
    }

    for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
      let depth = 0;
      let inString = false;
      let escaped = false;

      for (let index = start; index < text.length; index += 1) {
        const char = text[index];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === '\\') {
          escaped = true;
          continue;
        }
        if (char === '"') {
          inString = !inString;
          continue;
        }
        if (inString) {
          continue;
        }
        if (char === '{') {
          depth += 1;
        } else if (char === '}') {
          depth -= 1;
          if (depth === 0) {
            const parsedObject = tryCandidate(text.slice(start, index + 1));
            if (parsedObject) {
              return parsedObject;
            }
            break;
          }
        }
      }
    }
  }
  return null;
}

function stripLongEnglishRuns(value) {
  return normalizeWhitespace(
    String(value || '').replace(/(?:\b[A-Za-z][A-Za-z'/-]*\b[\s,;:()/"-]*){9,}/g, ' ')
  );
}

function isEnglishHeavyFragment(value) {
  const text = normalizeWhitespace(value);
  if (!text) {
    return true;
  }
  const latinCount = (text.match(/[A-Za-z]/g) || []).length;
  const chineseCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  return latinCount >= 24 && latinCount > chineseCount * 1.8;
}

function sanitizeInlineText(value) {
  const stripped = stripLongEnglishRuns(value);
  return isEnglishHeavyFragment(stripped) ? '' : stripped;
}

function sanitizeParagraphs(value) {
  return String(value || '')
    .split(/\n+/)
    .map((item) => sanitizeInlineText(item).replace(/^#{1,6}\s*/, ''))
    .filter(Boolean)
    .join('\n');
}

function clipForLlm(value, maxLength) {
  return truncate(normalizeWhitespace(value), maxLength);
}

function splitFullTextIntoChunks(cleanText, chunkSize = 7000, maxChunks = 8) {
  const text = normalizeWhitespace(cleanText);
  if (!text) {
    return [];
  }
  if (text.length <= chunkSize) {
    return [text];
  }
  const chunks = [];
  const step = Math.max(1, Math.floor((text.length - chunkSize) / Math.max(1, maxChunks - 1)));
  for (let index = 0; index < maxChunks; index += 1) {
    const start = Math.min(index * step, Math.max(0, text.length - chunkSize));
    const chunk = text.slice(start, start + chunkSize).trim();
    if (chunk && !chunks.includes(chunk)) {
      chunks.push(chunk);
    }
  }
  return chunks;
}

function partitionFullTextForLlm(cleanText, chunkSize = 12000, maxChunks = 8) {
  const text = normalizeWhitespace(cleanText);
  if (!text) {
    return [];
  }
  const chunks = [];
  for (let start = 0; start < text.length && chunks.length < maxChunks; start += chunkSize) {
    const chunk = text.slice(start, start + chunkSize).trim();
    if (chunk) {
      chunks.push(chunk);
    }
  }
  return chunks;
}

function extractKeywords(indexTermsText, title, abstract, introduction) {
  const direct = normalizeWhitespace(indexTermsText)
    .split(/[,;，；]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 1)
    .slice(0, 8);
  if (direct.length) {
    return direct;
  }
  const tokens = `${title}\n${abstract}\n${introduction}`.toLowerCase().match(/[a-z]{4,}|[\u4e00-\u9fff]{2,}/g) || [];
  const counts = new Map();
  for (const token of tokens) {
    if (STOPWORDS.has(token)) {
      continue;
    }
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([token]) => token);
}

function collectSentences(text) {
  return String(text || '').replace(/\n+/g, ' ').match(/[^.!?。！？]+[.!?。！？]?/g) || [];
}

function pickTopSentences(sentences, patterns, limit) {
  return [...sentences]
    .map((sentence) => ({
      sentence: normalizeWhitespace(sentence),
      score: patterns.reduce((total, pattern) => total + (pattern.test(sentence) ? 3 : 0), 0) + Math.min(sentence.length, 180) / 120
    }))
    .filter((item) => item.sentence)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.sentence);
}

function buildFallbackContent(source, options) {
  const abstractSentences = collectSentences(source.sections.abstract);
  const introSentences = collectSentences(source.sections.introduction);
  const methodSentences = collectSentences(source.sections.methods);
  const resultSentences = collectSentences(source.sections.experiments);
  const conclusionSentences = collectSentences(source.sections.conclusion);

  const hook = pickTopSentences([...abstractSentences, ...introSentences], [/propose|framework|system|method|joint|tradeoff|federated|edge|sensing|communication/i], 1)[0] || source.title;
  const problem = pickTopSentences([...introSentences, ...abstractSentences], [/challenge|demand|problem|motivat|need|tradeoff|latency|throughput|sensing/i], 3).join(' ');
  const method = pickTopSentences([...methodSentences, ...abstractSentences], [/propose|design|framework|algorithm|beamforming|optimization|joint|scheme/i], 3).join(' ');
  const results = pickTopSentences([...resultSentences, ...conclusionSentences, ...abstractSentences], [/result|improve|validate|demonstrate|show|gain|performance/i], 3).join(' ');
  const takeaway = pickTopSentences([...conclusionSentences, ...resultSentences, ...introSentences], [/important|practical|value|future|enable|support|promising/i], 2).join(' ') || results;

  return {
    articleTitle: source.title,
    hook,
    thread: options.threadLength === 'short'
      ? [
          `1/4 论文主题：${source.title}\n\n一句话抓主线：${truncate(hook, 160)}`,
          `2/4 这篇论文在解决什么问题？\n\n${truncate(problem || source.sections.introduction, 240) || '当前没有稳定提取到论文的问题背景。'}`,
          `3/4 作者的方法抓手是什么？\n\n${truncate(method || source.sections.methods, 240) || '当前没有稳定提取到论文的方法细节。'}`,
          `4/4 结果和价值在哪里？\n\n${truncate(results || takeaway, 240) || '当前没有稳定提取到论文的结果与结论。'}`
        ]
      : [
          `1/6 论文主题：${source.title}\n\n一句话抓主线：${truncate(hook, 160)}`,
          `2/6 这篇论文在解决什么问题？\n\n${truncate(problem || source.sections.introduction, 240) || '当前没有稳定提取到论文的问题背景。'}`,
          `3/6 作者的核心思路是什么？\n\n${truncate(method, 240) || '当前没有稳定提取到论文的核心思路。'}`,
          `4/6 具体方法由哪些部分组成？\n\n${truncate(source.sections.methods || method, 240) || '当前没有稳定提取到论文的方法细节。'}`,
          `5/6 实验或结果最值得看什么？\n\n${truncate(results || source.sections.experiments, 240) || '当前没有稳定提取到论文的关键结果。'}`,
          `6/6 这篇论文为什么值得继续跟？\n\n${truncate(takeaway, 240) || '当前没有稳定提取到论文的结论与意义。'}`
        ],
    outline: [
      { label: '研究背景', value: truncate(problem || source.sections.introduction, 220) || '当前没有稳定提取到研究背景。' },
      { label: '方法设计', value: truncate(method || source.sections.methods, 220) || '当前没有稳定提取到方法设计。' },
      { label: '关键结果', value: truncate(results || source.sections.experiments, 220) || '当前没有稳定提取到关键结果。' },
      { label: '研究结论', value: truncate(takeaway || source.sections.conclusion, 220) || '当前没有稳定提取到研究结论。' }
    ],
    keywords: source.keywords.slice(0, 6),
    post: [
      `论文标题：${source.title}`,
      '',
      `一句话总结：${truncate(hook, 180)}`,
      '',
      `问题：${truncate(problem, 220) || '当前没有稳定识别。'}`,
      `方法：${truncate(method, 220) || '当前没有稳定识别。'}`,
      `结果：${truncate(results, 220) || '当前没有稳定识别。'}`
    ].join('\n'),
    article: {
      lead: `这篇论文围绕“${source.title}”展开，下面的内容优先保留原文中能够直接确认的问题、方法和结果，不做虚构扩写。`,
      coreHighlight: truncate(hook, 200),
      background: [problem || source.sections.introduction || source.sections.abstract].filter(Boolean).map((item) => truncate(item, 220)),
      method: [method || source.sections.methods].filter(Boolean).map((item) => truncate(item, 220)),
      results: [results || source.sections.experiments || source.sections.conclusion].filter(Boolean).map((item) => truncate(item, 220)),
      takeaway: truncate(takeaway || results, 220)
    }
  };
}

function buildLlmPayload(source, fallback, options, distilledChunks = []) {
  return {
    paper: {
      title: source.title,
      authors: source.authors,
      journal: source.journal,
      doi: source.doi,
      pages: source.pages,
      keywords: source.keywords.slice(0, 8)
    },
    requirements: {
      audience: options.audience,
      tone: options.tone,
      focus: options.focus || '',
      threadItems: options.threadLength === 'short' ? 4 : 6
    },
    fallbackSignals: {
      hook: clipForLlm(fallback.hook, 220),
      outline: fallback.outline,
      keywords: fallback.keywords
    },
    evidence: {
      abstract: clipForLlm(cleanSectionNoise(source.sections.abstract, 'abstract'), 4500),
      introduction: clipForLlm(source.sections.introduction, 9000),
      methods: clipForLlm(source.sections.methods, 11000),
      experiments: clipForLlm(source.sections.experiments, 11000),
      conclusion: clipForLlm(source.sections.conclusion, 5000),
      fullTextPreview: clipForLlm(source.rawText, 12000),
      sectionWindows: splitFullTextIntoChunks(source.rawText, 7000, 6),
      distilledChunks
    }
  };
}

function buildHashtags(keywords) {
  return (Array.isArray(keywords) ? keywords : []).map((item) => `#${String(item || '').trim()}`).filter(Boolean).slice(0, 6);
}

function shouldRetryKimiRequest(error) {
  if (!axios.isAxiosError(error)) {
    return false;
  }
  const status = error.response?.status;
  const code = String(error.code || '').toUpperCase();
  return status === 429 || (typeof status === 'number' && status >= 500) || ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET'].includes(code);
}

function shouldRetryKimiGeneration(error) {
  if (shouldRetryKimiRequest(error)) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  const message = String(error.message || '').toLowerCase();
  return message.includes('non-json content') || message.includes('empty content') || message.includes('invalid json');
}

function extractAxiosErrorMessage(error) {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const remoteMessage = error.response?.data?.error?.message || error.response?.data?.message || error.response?.data?.error || error.message;
    const detail = typeof remoteMessage === 'string' ? remoteMessage : JSON.stringify(remoteMessage);
    return status ? `Kimi ${status}: ${detail}` : detail;
  }
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createDeadline(totalMs) {
  const expiresAt = Date.now() + totalMs;
  return { remainingMs() { return expiresAt - Date.now(); } };
}

function ensureBudget(deadline, label, minimumMs = 8000) {
  const remaining = deadline.remainingMs();
  if (remaining <= minimumMs) {
    throw new Error(`${label} timed out after ${Math.round(KIMI_TOTAL_TIMEOUT_MS / 1000)}s`);
  }
  return Math.min(KIMI_REQUEST_TIMEOUT_MS, remaining);
}

function parseRetryAfterMs(error) {
  if (!axios.isAxiosError(error)) {
    return null;
  }
  const rawValue = error.response?.headers?.['retry-after'];
  if (!rawValue) {
    return null;
  }
  const retryAfter = Array.isArray(rawValue) ? rawValue[0] : rawValue;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000;
  }
  const retryAt = Date.parse(String(retryAfter));
  return Number.isNaN(retryAt) ? null : Math.max(0, retryAt - Date.now());
}

function getRetryDelayMs(error, attempt, deadline) {
  const retryAfterMs = parseRetryAfterMs(error);
  const exponentialMs = KIMI_RETRY_BASE_MS * Math.pow(2, attempt);
  const desired = retryAfterMs || exponentialMs;
  const bounded = Math.min(desired, KIMI_RETRY_MAX_MS);
  const safeRemaining = Math.max(1000, deadline.remainingMs() - 8000);
  return Math.min(bounded, safeRemaining);
}

function getGenericRetryDelayMs(attempt, deadline) {
  const exponentialMs = KIMI_RETRY_BASE_MS * Math.pow(2, attempt);
  const bounded = Math.min(exponentialMs, KIMI_RETRY_MAX_MS);
  const safeRemaining = Math.max(1000, deadline.remainingMs() - 8000);
  return Math.min(bounded, safeRemaining);
}

async function requestJsonFromKimi({ apiKey, model, systemPrompt, payload, maxTokens, deadline, onRetry }) {
  const resolvedApiKey = resolveKimiApiKey(apiKey);
  if (!resolvedApiKey) {
    throw new Error('未配置 Kimi API 密钥。');
  }
  for (let attempt = 0; attempt <= KIMI_MAX_RETRIES; attempt += 1) {
    try {
      const timeoutMs = ensureBudget(deadline, 'Kimi generation');
      const response = await axios.post(
        `${KIMI_BASE_URL}/chat/completions`,
        {
          model,
          temperature: 0.15,
          max_tokens: maxTokens,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify(payload) }
          ]
        },
        {
          headers: { Authorization: `Bearer ${resolvedApiKey}`, 'Content-Type': 'application/json' },
          timeout: timeoutMs
        }
      );
      const parsed = tryParseJson(response.data?.choices?.[0]?.message?.content || '');
      if (!parsed) {
        throw new Error('Kimi returned non-JSON content.');
      }
      return parsed;
    } catch (error) {
      if (attempt >= KIMI_MAX_RETRIES || !shouldRetryKimiGeneration(error)) {
        throw error;
      }
      const waitMs = axios.isAxiosError(error)
        ? getRetryDelayMs(error, attempt, deadline)
        : getGenericRetryDelayMs(attempt, deadline);
      if (waitMs <= 1000) {
        throw error;
      }
      if (typeof onRetry === 'function') {
        onRetry({ attempt: attempt + 1, waitMs, detail: extractAxiosErrorMessage(error) });
      }
      await sleep(waitMs);
    }
  }
  return null;
}

async function requestTextFromKimi({ apiKey, model, systemPrompt, payload, maxTokens, deadline, onRetry }) {
  const resolvedApiKey = resolveKimiApiKey(apiKey);
  if (!resolvedApiKey) {
    throw new Error('未配置 Kimi API 密钥。');
  }
  for (let attempt = 0; attempt <= KIMI_MAX_RETRIES; attempt += 1) {
    try {
      const timeoutMs = ensureBudget(deadline, 'Kimi generation');
      const response = await axios.post(
        `${KIMI_BASE_URL}/chat/completions`,
        {
          model,
          temperature: 0.2,
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify(payload) }
          ]
        },
        {
          headers: { Authorization: `Bearer ${resolvedApiKey}`, 'Content-Type': 'application/json' },
          timeout: timeoutMs
        }
      );
      const text = normalizeWhitespace(response.data?.choices?.[0]?.message?.content || '');
      if (!text) {
        throw new Error('Kimi returned empty content.');
      }
      return text;
    } catch (error) {
      if (attempt >= KIMI_MAX_RETRIES || !shouldRetryKimiRequest(error)) {
        throw error;
      }
      const waitMs = getRetryDelayMs(error, attempt, deadline);
      if (waitMs <= 1000) {
        throw error;
      }
      if (typeof onRetry === 'function') {
        onRetry({ attempt: attempt + 1, waitMs, detail: extractAxiosErrorMessage(error) });
      }
      await sleep(waitMs);
    }
  }
  return '';
}

async function extractMetadataWithKimi(input) {
  const apiKey = resolveKimiApiKey(input.apiKey);
  if (!apiKey) {
    return null;
  }
  const payload = {
    pdfMetadata: {
      title: normalizeWhitespace(input.pdfInfo?.Title || ''),
      author: normalizeWhitespace(input.pdfInfo?.Author || ''),
      subject: normalizeWhitespace(input.pdfInfo?.Subject || ''),
      keywords: normalizeWhitespace(input.pdfInfo?.Keywords || ''),
      fileName: input.originalName
    },
    headerSnippet: buildHeaderLines(input.rawText).join('\n'),
    titleAndAuthorWindow: buildHeaderLines(input.rawText).slice(0, 8).join('\n'),
    firstPageSnippet: normalizeWhitespace(String(input.rawText || '').slice(0, 2600)),
    authorCandidateBlock: extractAuthors(input.rawText, '', input.localTitle, null),
    localGuess: {
      title: input.localTitle,
      authors: input.localAuthors,
      journal: input.localJournal,
      doi: input.localDoi
    },
    doiLookup: input.doiMetadata || null,
    titleLookup: input.titleMetadata || null
  };
  if (!payload.headerSnippet) {
    return null;
  }
  try {
    return await requestJsonFromKimi({
      apiKey,
      model: KIMI_METADATA_MODEL,
      systemPrompt: [
        'You extract academic paper metadata from PDF evidence.',
        'Your highest-priority field is authors.',
        'Use only the PDF header snippet, title-and-author window, first-page snippet, PDF metadata, DOI lookup, and title lookup.',
        'Prefer the author line immediately below the title in the PDF text over generic PDF metadata.',
        'Prefer authorCandidateBlock when it contains person names.',
        'Ignore tool names, software names, affiliations, emails, departments, and conference or journal names when extracting authors.',
        'Never return a title fragment such as a paper title segment as authors.',
        'If any field is uncertain, return an empty string for that field.',
        'Authors must be a comma-separated list of names.',
        'Return valid JSON only.',
        'Schema: {"title":"string","authors":"string","journal":"string","doi":"string"}'
      ].join('\n'),
      payload,
      maxTokens: 500,
      deadline: createDeadline(45000)
    });
  } catch (_error) {
    return null;
  }
}

async function distillFullTextChunksWithLlm(source, deadline, reportProgress, apiKey) {
  const chunks = partitionFullTextForLlm(source.rawText, 12000, 8);
  if (chunks.length <= 1) {
    return [];
  }
  const notes = [];
  for (let index = 0; index < chunks.length; index += 1) {
    reportProgress({ step: 'llm-read', label: `正在阅读全文分块 ${index + 1}/${chunks.length}。`, percent: 42 + Math.round(((index + 1) / chunks.length) * 10) });
    const parsed = await requestJsonFromKimi({
      apiKey,
      model: KIMI_WRITING_MODEL,
      systemPrompt: [
        'You are extracting evidence notes from one sequential chunk of an academic paper.',
        'Use only the provided chunk and metadata.',
        'Return concise Simplified Chinese evidence notes.',
        'Do not invent any fact not present in the chunk.',
        'Return valid JSON only.',
        'Schema: {"summary":"string","problem":["string"],"method":["string"],"results":["string"],"limits":["string"],"terms":["string"]}'
      ].join('\n'),
      payload: {
        paper: { title: source.title, authors: source.authors, journal: source.journal, doi: source.doi },
        chunkIndex: index + 1,
        totalChunks: chunks.length,
        chunkText: chunks[index]
      },
      maxTokens: 900,
      deadline
    });
    notes.push({
      index: index + 1,
      summary: sanitizeInlineText(parsed?.summary || ''),
      problem: Array.isArray(parsed?.problem) ? parsed.problem.map((item) => sanitizeInlineText(item)).filter(Boolean).slice(0, 4) : [],
      method: Array.isArray(parsed?.method) ? parsed.method.map((item) => sanitizeInlineText(item)).filter(Boolean).slice(0, 5) : [],
      results: Array.isArray(parsed?.results) ? parsed.results.map((item) => sanitizeInlineText(item)).filter(Boolean).slice(0, 5) : [],
      limits: Array.isArray(parsed?.limits) ? parsed.limits.map((item) => sanitizeInlineText(item)).filter(Boolean).slice(0, 4) : [],
      terms: Array.isArray(parsed?.terms) ? parsed.terms.map((item) => sanitizeInlineText(item)).filter(Boolean).slice(0, 6) : []
    });
  }
  return notes;
}

function normalizeGeneratedContent(generated, fallback, options) {
  if (!generated || typeof generated !== 'object') {
    return fallback;
  }
  const thread = Array.isArray(generated.thread) ? generated.thread.map((item) => sanitizeInlineText(item)).filter(Boolean) : fallback.thread;
  const outline = Array.isArray(generated.outline)
    ? generated.outline.map((item) => ({ label: sanitizeInlineText(item?.label), value: sanitizeInlineText(item?.value) })).filter((item) => item.label && item.value)
    : fallback.outline;
  const keywords = Array.isArray(generated.keywords) ? generated.keywords.map((item) => sanitizeInlineText(item)).filter(Boolean).slice(0, 6) : fallback.keywords;
  const article = generated.article && typeof generated.article === 'object'
    ? {
        lead: sanitizeInlineText(generated.article.lead || fallback.article.lead),
        coreHighlight: sanitizeInlineText(generated.article.coreHighlight || fallback.article.coreHighlight),
        background: Array.isArray(generated.article.background) ? generated.article.background.map((item) => sanitizeInlineText(item)).filter(Boolean) : fallback.article.background,
        method: Array.isArray(generated.article.method) ? generated.article.method.map((item) => sanitizeInlineText(item)).filter(Boolean) : fallback.article.method,
        results: Array.isArray(generated.article.results) ? generated.article.results.map((item) => sanitizeInlineText(item)).filter(Boolean) : fallback.article.results,
        takeaway: sanitizeInlineText(generated.article.takeaway || fallback.article.takeaway)
      }
    : fallback.article;
  let post = sanitizeParagraphs(generated.post || fallback.post);
  if (post.length < 900) {
    post = [
      article.lead,
      '',
      `核心亮点：${article.coreHighlight}`,
      '',
      '背景与问题：',
      ...article.background.map((item) => `- ${item}`),
      '',
      '方法与思路：',
      ...article.method.map((item) => `- ${item}`),
      '',
      '关键结果：',
      ...article.results.map((item) => `- ${item}`),
      '',
      `结语：${article.takeaway}`
    ].join('\n');
  }
  return {
    articleTitle: sanitizeInlineText(generated.articleTitle || fallback.articleTitle) || fallback.articleTitle,
    hook: sanitizeInlineText(generated.hook || fallback.hook) || fallback.hook,
    thread: (options.threadLength === 'short' ? thread.slice(0, 4) : thread.slice(0, 6)).filter(Boolean),
    post,
    outline: outline.length ? outline : fallback.outline,
    keywords: keywords.length ? keywords : fallback.keywords,
    article
  };
}

function buildWordHtml({ title, article, metadata, keywords, post }) {
  const summaryParagraphs = String(post || '').split(/\n+/).map((item) => item.trim()).filter(Boolean).map((item) => `<p>${escapeHtml(item)}</p>`).join('');
  const backgroundItems = article.background.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  const methodItems = article.method.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  const resultItems = article.results.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  const keywordTags = keywords.map((item) => `#${escapeHtml(item)}`).join(' ');
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>${escapeHtml(title)}</title><style>body { font-family: "Microsoft YaHei", "PingFang SC", sans-serif; color: #1f2328; line-height: 1.85; margin: 0; padding: 42px 52px; } h1 { font-size: 28px; line-height: 1.35; margin: 0 0 22px; padding-bottom: 14px; border-bottom: 3px solid #2563eb; } h2 { font-size: 20px; margin: 26px 0 14px; padding-left: 12px; border-left: 4px solid #ea580c; } p { margin: 12px 0; text-align: justify; } ul { margin: 12px 0; padding-left: 24px; } li { margin-bottom: 10px; } .lead { font-size: 16px; color: #374151; } .highlight-box { background: #fff7ed; border: 1px solid #fdba74; border-left: 4px solid #ea580c; padding: 16px 18px; margin: 20px 0; font-weight: 600; } .meta { background: #f8fafc; border: 1px solid #dbeafe; padding: 18px; margin-top: 28px; } .meta li { list-style: none; margin: 8px 0; } .meta strong { color: #1d4ed8; } .footer { margin-top: 30px; padding-top: 16px; border-top: 1px solid #d1d5db; color: #4b5563; }</style></head><body><h1>${escapeHtml(title)}</h1><p class="lead">${escapeHtml(article.lead)}</p><div class="highlight-box">核心亮点：${escapeHtml(article.coreHighlight)}</div><h2>长稿正文</h2>${summaryParagraphs}<h2>背景与问题</h2><ul>${backgroundItems}</ul><h2>方法与思路</h2><ul>${methodItems}</ul><h2>关键结果</h2><ul>${resultItems}</ul><h2>论文信息</h2><ul class="meta"><li><strong>标题：</strong>${escapeHtml(metadata.title)}</li><li><strong>作者：</strong>${escapeHtml(metadata.authors || '未稳定识别')}</li><li><strong>期刊/来源：</strong>${escapeHtml(metadata.journal || '未稳定识别')}</li><li><strong>DOI：</strong>${escapeHtml(metadata.doi || '未稳定识别')}</li><li><strong>关键词：</strong>${escapeHtml(keywords.join(' / ') || '未稳定识别')}</li></ul><h2>结语</h2><p>${escapeHtml(article.takeaway)}</p><div class="footer"><p>这份文稿优先保证基于论文原文，不做虚构补充。标签：${keywordTags}</p></div></body></html>`;
}

function updateProgress(progressId, patch) {
  const id = String(progressId || '').trim();
  if (!id) {
    return;
  }
  const previous = progressStore.get(id) || { status: 'idle', step: 'idle', label: '', percent: 0, detail: null, events: [] };
  const snapshot = { ...previous, ...patch, updatedAt: new Date().toISOString() };
  const event = { status: snapshot.status, step: snapshot.step, label: snapshot.label, percent: snapshot.percent, detail: snapshot.detail || null, updatedAt: snapshot.updatedAt };
  snapshot.events = [...(previous.events || []), event].slice(-40);
  progressStore.set(id, snapshot);
  console.log(`[progress:${id}] ${snapshot.percent}% ${snapshot.step} - ${snapshot.label}${snapshot.detail ? ` | ${snapshot.detail}` : ''}`);
}

function finalizeProgress(progressId, patch) {
  updateProgress(progressId, patch);
}

async function extractPaperData(file, apiKey) {
  const parser = new PDFParse({ data: file.buffer });
  const textResult = await parser.getText();
  const infoResult = await parser.getInfo({ parsePageInfo: false });
  await parser.destroy();

  const rawText = textResult.text || '';
  const cleanText = cleanPdfText(rawText);
  const sections = parseSections(cleanText);
  const documentType = detectDocumentType({
    originalName: file.originalname,
    rawText,
    cleanText,
    sections,
    pages: Number(infoResult.total || 0)
  });
  const localTitle = pickTitle(infoResult.info || {}, file.originalname, rawText);
  const titleMetadata = await lookupMetadataByTitle(localTitle);
  const doi = extractDoi(rawText, infoResult.info || {});
  const doiMetadata = await lookupDoiMetadata(doi);
  const localAuthors = extractAuthors(rawText, infoResult.info?.Author, localTitle, doiMetadata);
  const localJournal = extractJournal(rawText, infoResult.info || {}, doiMetadata);
  const llmMetadata = await extractMetadataWithKimi({
    apiKey,
    rawText,
    pdfInfo: infoResult.info || {},
    originalName: file.originalname,
    localTitle,
    localAuthors,
    localJournal,
    localDoi: doi,
    doiMetadata,
    titleMetadata
  });
  const resolved = resolvePaperMetadata({ localTitle, localAuthors, localJournal, localDoi: doi, doiMetadata, titleMetadata, llmMetadata });
  const keywords = extractKeywords(sections.indexTerms, resolved.title, sections.abstract, sections.introduction);

  return {
    title: resolved.title,
    authors: resolved.authors,
    journal: resolved.journal,
    doi: resolved.doi,
    pages: Number(infoResult.total || 0),
    characters: cleanText.length,
    paragraphs: cleanText.split(/\n{2,}/).filter(Boolean).length,
    keywords,
    sections,
    rawText: cleanText,
    documentType
  };
}

async function generateWithLlm(source, fallback, options, onProgress, apiKey) {
  const deadline = createDeadline(KIMI_TOTAL_TIMEOUT_MS);
  const reportProgress = typeof onProgress === 'function' ? onProgress : () => {};
  const resolvedApiKey = resolveKimiApiKey(apiKey);
  if (!resolvedApiKey) {
    throw new Error('未配置 Kimi API 密钥。');
  }
  const distilledChunks = normalizeWhitespace(source.rawText).length > 22000
    ? await distillFullTextChunksWithLlm(source, deadline, reportProgress, resolvedApiKey)
    : [];
  const payload = buildLlmPayload(source, fallback, options, distilledChunks);

  reportProgress({ step: 'llm-draft', label: '正在生成结构骨架。', percent: 56 });
  const structure = await requestJsonFromKimi({
    apiKey: resolvedApiKey,
    model: KIMI_WRITING_MODEL,
    systemPrompt: [
      'You are writing a high-quality Chinese WeChat article plan based on an academic paper.',
      'Read the full paper evidence, not only the abstract.',
      'Use the distilledChunks notes when they are present; together they cover the full paper.',
      'Use only the provided evidence. Do not invent authors, institutions, datasets, baselines, numbers, or gains.',
      'If a fact is not clearly stated in the paper, say the paper does not clearly state it.',
      'Write all final content in fluent Simplified Chinese.',
      'Do not copy raw English fragments longer than a short technical term.',
      'Do not write a generic trend introduction unless the paper explicitly frames itself that way.',
      'Return valid JSON only.',
      'Schema: {"articleTitle":"string","hook":"string","thread":["string"],"outline":[{"label":"string","value":"string"}],"keywords":["string"],"article":{"lead":"string","coreHighlight":"string","background":["string"],"method":["string"],"results":["string"],"takeaway":"string"}}',
      `Thread must contain exactly ${payload.requirements.threadItems} items.`,
      'background, method, and results should each contain 4 to 6 concrete items.',
      'article.lead should be detailed and paper-specific.'
    ].join('\n'),
    payload,
    maxTokens: 2600,
    deadline,
    onRetry: ({ attempt, waitMs, detail }) => {
      reportProgress({ step: 'llm-retry', label: `Moonshot 繁忙，准备重试（${attempt}/${KIMI_MAX_RETRIES}）。`, percent: 58, detail: `${detail} | wait ${Math.round(waitMs / 1000)}s` });
    }
  });

  reportProgress({ step: 'llm-post', label: '结构骨架已完成，正在生成长稿正文。', percent: 68 });
  const post = await requestTextFromKimi({
    apiKey: resolvedApiKey,
    model: KIMI_WRITING_MODEL,
    systemPrompt: [
      'You are writing the final Chinese WeChat long-form article body for an academic paper.',
      'Use only the provided paper evidence and structured draft.',
      'Write 8 to 12 natural Chinese paragraphs with real depth.',
      'Cover the problem, system setting, method, optimization or algorithm, experiment setup, key results, value, and limitations.',
      'Do not invent data or claims not supported by the evidence.',
      'Do not output Markdown fences, JSON, or bullet-only content.'
    ].join('\n'),
    payload: {
      paper: payload.paper,
      requirements: payload.requirements,
      evidence: payload.evidence,
      structuredDraft: structure
    },
    maxTokens: 3200,
    deadline,
    onRetry: ({ attempt, waitMs, detail }) => {
      reportProgress({ step: 'llm-retry', label: `Moonshot 繁忙，准备重试（${attempt}/${KIMI_MAX_RETRIES}）。`, percent: 70, detail: `${detail} | wait ${Math.round(waitMs / 1000)}s` });
    }
  });

  return { ...structure, post };
}

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    llmConfigured: false,
    manualKeyRequired: true,
    model: null,
    metadataModel: null,
    localFallbackEnabled: KIMI_ALLOW_LOCAL_FALLBACK
  });
});

app.get('/api/progress/:id', (req, res) => {
  const snapshot = progressStore.get(String(req.params.id || '').trim());
  if (!snapshot) {
    return res.status(404).json({ error: '未找到对应的进度记录。' });
  }
  return res.json(snapshot);
});

app.get('/api/result/:id', (req, res) => {
  const payload = resultStore.get(String(req.params.id || '').trim());
  if (!payload) {
    return res.status(404).json({ error: '未找到对应的生成结果。' });
  }
  return res.json(payload);
});

app.post('/api/generate-thread', upload.single('file'), async (req, res) => {
  const progressId = String(req.body.progressId || req.headers['x-progress-id'] || '').trim();
  if (progressId) {
    resultStore.delete(progressId);
  }

  try {
    updateProgress(progressId, { status: 'uploading', step: 'received', label: '已接收文件，正在校验上传内容。', percent: 5 });
    if (!req.file) {
      finalizeProgress(progressId, { status: 'error', step: 'received', label: '没有接收到 PDF 文件。', percent: 100 });
      return res.status(400).json({ error: '请先上传 PDF 文件。' });
    }
    if (req.file.mimetype !== 'application/pdf') {
      finalizeProgress(progressId, { status: 'error', step: 'received', label: '上传的文件不是 PDF。', percent: 100 });
      return res.status(400).json({ error: '目前只支持 PDF 文件。' });
    }

    const options = {
      tone: String(req.body.tone || 'analysis'),
      audience: String(req.body.audience || 'general'),
      threadLength: String(req.body.threadLength || 'medium'),
      focus: String(req.body.focus || '').trim()
    };
    const requestKimiApiKey = resolveKimiApiKey(req.body.kimiApiKey || '');

    updateProgress(progressId, { status: 'extracting', step: 'parsing', label: '正在解析 PDF 正文与元信息。', percent: 18 });
    const paper = await extractPaperData(req.file, requestKimiApiKey);
    if (!paper.rawText || paper.rawText.length < 500) {
      finalizeProgress(progressId, { status: 'error', step: 'parsing', label: 'PDF 文本层过短或噪声过高，无法稳定生成。', percent: 100 });
      return res.status(422).json({ error: 'PDF 文本层过短或噪声过高，暂时无法稳定生成。' });
    }

    updateProgress(progressId, { status: 'extracting', step: 'structuring', label: '全文已提取，正在整理标题、作者、期刊和内容结构。', percent: 34 });
    const fallback = buildFallbackContent(paper, options);

    let llmOutput = null;
    let llmError = null;
    if (requestKimiApiKey) {
      try {
        llmOutput = await generateWithLlm(
          paper,
          fallback,
          options,
          (patch) => updateProgress(progressId, { status: 'writing', ...patch }),
          requestKimiApiKey
        );
      } catch (error) {
        llmError = extractAxiosErrorMessage(error);
        if (!KIMI_ALLOW_LOCAL_FALLBACK) {
          finalizeProgress(progressId, { status: 'error', step: 'llm', label: 'Moonshot 当前繁忙或超时，请稍后重试。', percent: 100, detail: llmError });
          return res.status(503).json({ error: 'Moonshot 当前繁忙或超时，请稍后重试。', detail: llmError, code: 'LLM_UNAVAILABLE' });
        }
      }
    }

    if (!requestKimiApiKey) {
      finalizeProgress(progressId, { status: 'error', step: 'llm', label: '请先输入你的 Kimi API 密钥。', percent: 100 });
      return res.status(400).json({ error: '请先输入你的 Kimi API 密钥。', code: 'MISSING_KIMI_API_KEY' });
    }

    const generated = normalizeGeneratedContent(llmOutput, fallback, options);
    const finalKeywords = generated.keywords.length ? generated.keywords : paper.keywords.slice(0, 6);

    updateProgress(progressId, { status: 'writing', step: 'rendering', label: '内容已生成，正在渲染 HTML 与 Word。', percent: 82, detail: llmError });

    const previewHtml = buildWordHtml({
      title: generated.articleTitle,
      article: generated.article,
      post: generated.post,
      metadata: { title: paper.title, authors: paper.authors, journal: paper.journal, doi: paper.doi },
      keywords: finalKeywords
    });

    const exportBaseName = `${Date.now()}-${slugify(generated.articleTitle)}`;
    const htmlFilename = `${exportBaseName}.html`;
    const docxFilename = `${exportBaseName}.docx`;
    fs.writeFileSync(path.join(GENERATED_DIR, htmlFilename), previewHtml, 'utf8');
    const docxBuffer = await buildDocxBuffer({
      title: generated.articleTitle,
      article: generated.article,
      post: generated.post,
      metadata: { title: paper.title, authors: paper.authors, journal: paper.journal, doi: paper.doi },
      keywords: finalKeywords
    });
    fs.writeFileSync(path.join(GENERATED_DIR, docxFilename), docxBuffer);

    const payload = {
      file: { name: req.file.originalname, size: req.file.size, pages: paper.pages },
      extracted: {
        title: paper.title,
        authors: paper.authors,
        journal: paper.journal,
        doi: paper.doi,
        abstract: cleanSectionNoise(paper.sections.abstract, 'abstract') || truncate(paper.rawText, 400),
        keywords: finalKeywords,
        outline: generated.outline
      },
      output: {
        hook: generated.hook,
        thread: generated.thread,
        post: generated.post,
        hashtags: buildHashtags(finalKeywords),
        previewHtml
      },
      export: {
        docxUrl: `/downloads/${docxFilename}` ,
        fileName: docxFilename,
        htmlUrl: `/downloads/${htmlFilename}` ,
        htmlFileName: htmlFilename
      },
      diagnostics: {
        characters: paper.characters,
        paragraphs: paper.paragraphs,
        sectionsFound: Object.entries(paper.sections).filter(([, value]) => normalizeWhitespace(value)).map(([key]) => key),
        llmUsed: Boolean(llmOutput),
        llmError: llmError || null
      }
    };

    if (progressId) {
      resultStore.set(progressId, payload);
    }

    finalizeProgress(progressId, { status: 'done', step: 'completed', label: 'HTML 与 Word 已导出完成。', percent: 100, detail: llmError });

    return res.json(payload);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    finalizeProgress(progressId, { status: 'error', step: 'failed', label: '生成失败，请查看错误详情。', percent: 100, detail });
    return res.status(500).json({ error: detail });
  }
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    return res.status(400).json({ error: error.message });
  }
  return res.status(500).json({ error: error instanceof Error ? error.message : '服务器出现未知错误。' });
});

app.listen(PORT, () => {
  console.log(`论文转公众号工作台 API 已启动，端口 ${PORT}`);
});
