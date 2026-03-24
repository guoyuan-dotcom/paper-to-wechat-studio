'use client';

import type { ReactNode } from 'react';
import { ChangeEvent, DragEvent, startTransition, useDeferredValue, useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  CheckCircle2,
  Copy,
  Download,
  FileText,
  Hash,
  Loader2,
  Orbit,
  PenSquare,
  ScanSearch,
  Sparkles,
  Upload,
  Wand2
} from 'lucide-react';

type GenerationResponse = {
  file: {
    name: string;
    size: number;
    pages: number;
  };
  extracted: {
    title: string;
    authors?: string;
    journal?: string;
    doi?: string;
    abstract: string;
    keywords: string[];
    outline: Array<{ label: string; value: string }>;
  };
  output: {
    hook: string;
    thread: string[];
    post: string;
    hashtags: string[];
    previewHtml: string;
  };
  export: {
    docxUrl: string;
    fileName: string;
    htmlUrl: string;
    htmlFileName: string;
  };
  diagnostics: {
    characters: number;
    paragraphs: number;
    sectionsFound: string[];
    llmUsed?: boolean;
    llmError?: string | null;
  };
};

type GenerationProgress = {
  status: string;
  step: string;
  label: string;
  percent: number;
  detail?: string | null;
  updatedAt?: string;
  events?: Array<{
    status: string;
    step: string;
    label: string;
    percent: number;
    detail?: string | null;
    updatedAt?: string;
  }>;
};

type Status = 'idle' | 'uploading' | 'extracting' | 'writing' | 'done' | 'error';

type PersistedState = {
  result: GenerationResponse | null;
  editablePost: string;
  tone: string;
  audience: string;
  threadLength: string;
  focus: string;
};

type ProgressLogItem = GenerationProgress & {
  id: string;
};

const BACKEND_ORIGIN = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001';
const GENERATION_TIMEOUT_MS = 420000;
const RESULT_RECOVERY_RETRIES = 8;
const RESULT_RECOVERY_DELAY_MS = 1500;
const RESULT_STORAGE_KEY = 'research-workbench:last-result:v3';
const APP_BADGE = '论文转公众号工作台';
const APP_TITLE = '论文转公众号工作台';
const APP_KICKER = '科研论文转写 / HTML / Word';
const APP_DESCRIPTION =
  '上传科研论文 PDF，实时查看解析、写作和导出进度，生成适合中文公众号发布的线程稿、HTML 成稿和 Word 文档。';

const FLOW_STEPS = ['拖入 PDF', '解析结构', '生成线程', '导出 HTML / Word'];
const PROGRESS_DETAIL_STAGES = [
  ['received', '接收文件', '已接收 PDF 与参数，准备进入解析链路。'],
  ['parsing', '解析正文', '提取正文文本、页数和基础结构。'],
  ['structuring', '提取元信息', '整理标题、作者、期刊、DOI 与关键词。'],
  ['llm-read', '阅读全文块', '分块阅读全文，为写作建立证据上下文。'],
  ['llm-thread', '生成线程', '产出适合公众号转发的线程结构。'],
  ['llm-article', '生成长稿', '生成可继续编辑的公众号长文正文。'],
  ['rendering', '导出文件', '渲染 HTML 预览并生成 Word 文件。']
] as const;

const TONE_OPTIONS = [
  ['crisp', '干净直接'],
  ['analytical', '分析型'],
  ['bold', '更有传播性']
] as const;

const AUDIENCE_OPTIONS = [
  ['general', '泛读者'],
  ['researcher', '研究者'],
  ['product', '应用/产品']
] as const;

const THREAD_OPTIONS = [
  ['short', '4 条精简版'],
  ['medium', '6 条完整版']
] as const;

export default function Home() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [tone, setTone] = useState('crisp');
  const [audience, setAudience] = useState('general');
  const [threadLength, setThreadLength] = useState('medium');
  const [focus, setFocus] = useState('');
  const [kimiApiKey, setKimiApiKey] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');
  const [result, setResult] = useState<GenerationResponse | null>(null);
  const [progress, setProgress] = useState<GenerationProgress | null>(null);
  const [progressHistory, setProgressHistory] = useState<ProgressLogItem[]>([]);
  const [editablePost, setEditablePost] = useState('');
  const [copiedKey, setCopiedKey] = useState('');
  const [downloadingKey, setDownloadingKey] = useState('');
  const [isHydrated, setIsHydrated] = useState(false);

  const deferredFocus = useDeferredValue(focus);

  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(RESULT_STORAGE_KEY);
      if (!raw) {
        setIsHydrated(true);
        return;
      }

      const persisted = JSON.parse(raw) as PersistedState;
      if (persisted.result) {
        setResult(normalizeResultUrls(persisted.result));
      }
      setEditablePost(String(persisted.editablePost || ''));
      setTone(String(persisted.tone || 'crisp'));
      setAudience(String(persisted.audience || 'general'));
      setThreadLength(String(persisted.threadLength || 'medium'));
      setFocus(String(persisted.focus || ''));
      setStatus(persisted.result ? 'done' : 'idle');
    } catch (_error) {
      window.sessionStorage.removeItem(RESULT_STORAGE_KEY);
    } finally {
      setIsHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!isHydrated) {
      return;
    }

    const payload: PersistedState = {
      result,
      editablePost,
      tone,
      audience,
      threadLength,
      focus
    };

    window.sessionStorage.setItem(RESULT_STORAGE_KEY, JSON.stringify(payload));
  }, [audience, editablePost, focus, isHydrated, result, threadLength, tone]);

  function updateFile(nextFile: File | null) {
    if (!nextFile) {
      return;
    }

    if (nextFile.type !== 'application/pdf') {
      setError('只支持 PDF 文件。');
      return;
    }

    setError('');
    setFile(nextFile);
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    updateFile(event.target.files?.[0] || null);
  }

  function onDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    updateFile(event.dataTransfer.files?.[0] || null);
  }

  function updateProgressSnapshot(next: GenerationProgress) {
    const stamped: GenerationProgress = {
      ...next,
      updatedAt: next.updatedAt || new Date().toISOString()
    };

    setProgress(stamped);
    if (Array.isArray(stamped.events) && stamped.events.length > 0) {
      setProgressHistory(
        stamped.events.map((item, index) => ({
          ...item,
          updatedAt: item.updatedAt || stamped.updatedAt,
          id: `${item.updatedAt || stamped.updatedAt}-${item.step}-${item.percent}-${index}`
        }))
      );
      return;
    }

    setProgressHistory((current) => {
      const last = current[current.length - 1];
      if (
        last &&
        last.status === stamped.status &&
        last.step === stamped.step &&
        last.label === stamped.label &&
        last.percent === stamped.percent &&
        (last.detail || '') === (stamped.detail || '')
      ) {
        return current;
      }

      return [
        ...current.slice(-7),
        {
          ...stamped,
          id: `${stamped.updatedAt}-${stamped.step}-${stamped.percent}`
        }
      ];
    });
  }

  async function onGenerate() {
    if (!file) {
      setError('请先上传 PDF。');
      return;
    }
    if (!kimiApiKey.trim()) {
      setError('先输入 Kimi API 密钥。');
      return;
    }

    setError('');
    setStatus('uploading');
    setResult(null);
    setProgress(null);
    setProgressHistory([]);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('tone', tone);
    formData.append('audience', audience);
    formData.append('threadLength', threadLength);
    formData.append('focus', focus.trim());
    if (kimiApiKey.trim()) {
      formData.append('kimiApiKey', kimiApiKey.trim());
    }

    const progressId =
      globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    formData.append('progressId', progressId);

    let requestSettled = false;
    let keepPollingForRecovery = false;

    const stopPolling = startProgressPolling(progressId, updateProgressSnapshot, async (snapshot) => {
      if (!keepPollingForRecovery || requestSettled) {
        return;
      }

      if (snapshot.status === 'done') {
        try {
          const recoveredResult = await recoverCompletedResult(progressId);
          requestSettled = true;

          startTransition(() => {
            setError('');
            setResult(recoveredResult);
            setEditablePost(String(recoveredResult.output.post || ''));
            updateProgressSnapshot({
              status: 'done',
              step: 'completed',
              label: '后台已完成，正在恢复 HTML / Word 结果。',
              percent: 100,
              detail: recoveredResult.diagnostics.llmError || null
            });
            setStatus('done');
          });
        } catch (recoveryError) {
          const message = recoveryError instanceof Error ? recoveryError.message : '恢复结果失败。';
          requestSettled = true;
          setStatus('error');
          setError(message === 'RESULT_NOT_READY' ? '后台仍在生成，暂时还没有可恢复的结果。' : message);
        }
        return;
      }

      if (snapshot.status === 'error') {
        requestSettled = true;
        setStatus('error');
        setError(snapshot.detail || snapshot.label || '生成失败。');
      }
    });

    updateProgressSnapshot({
      status: 'uploading',
      step: 'queued',
      label: '请求已提交，正在进入处理队列。',
      percent: 2
    });

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), GENERATION_TIMEOUT_MS);

    try {
      setStatus('extracting');

      const response = await fetch(resolveBackendUrl('/api/generate-thread'), {
        method: 'POST',
        body: formData,
        signal: controller.signal
      });

      setStatus('writing');

      const rawText = await response.text();
      let data: Record<string, any> = {};

      try {
        data = rawText ? JSON.parse(rawText) : {};
      } catch (_parseError) {
        data = {
          error: rawText || `请求失败（HTTP ${response.status}）`
        };
      }

      if (!response.ok) {
        throw new Error(String(data.error || data.detail || `请求失败（HTTP ${response.status}）`));
      }

      if (!data.output || !data.export) {
        throw new Error('返回结果不完整，请重试。');
      }

      const normalizedResult = normalizeResultUrls(data as GenerationResponse);
      requestSettled = true;

      startTransition(() => {
        setError('');
        setResult(normalizedResult);
        setEditablePost(String(normalizedResult.output.post || ''));
        updateProgressSnapshot({
          status: 'done',
          step: 'completed',
          label: '已生成 HTML / Word 导出包。',
          percent: 100,
          detail: normalizedResult.diagnostics.llmError || null
        });
        setStatus('done');
      });
    } catch (requestError) {
      if (requestError instanceof DOMException && requestError.name === 'AbortError') {
        keepPollingForRecovery = true;
        setStatus('writing');
        setError('主请求等待超时，后台仍可能继续生成，我会继续尝试回收结果。');
        updateProgressSnapshot({
          status: 'writing',
          step: 'waiting-result',
          label: '主请求已超时，正在等待后台完成并回填结果。',
          percent: clampPercent(progress?.percent || 68)
        });
      } else {
        requestSettled = true;
        setStatus('error');
        const message = requestError instanceof Error ? requestError.message : '生成失败。';
        setError(message);
        updateProgressSnapshot({
          status: 'error',
          step: 'failed',
          label: '生成失败，请查看错误信息。',
          percent: progress?.percent || 100,
          detail: message
        });
      }
    } finally {
      window.clearTimeout(timeoutId);
      if (!keepPollingForRecovery) {
        stopPolling();
      }
    }
  }

  async function downloadExport(url: string, fileName: string, key: string) {
    try {
      setDownloadingKey(key);
      setError('');

      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`下载失败（HTTP ${response.status}）`);
      }

      const blob = await response.blob();
      const objectUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(objectUrl);
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : '下载失败');
    } finally {
      setDownloadingKey('');
    }
  }

  async function copyText(key: string, text: string) {
    await navigator.clipboard.writeText(text);
    setCopiedKey(key);
    window.setTimeout(() => setCopiedKey(''), 1200);
  }

  function getPreviewDocument(html: string) {
    if (/<html[\s>]/i.test(html)) {
      return html;
    }

    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" /></head><body>${html}</body></html>`;
  }

  const percent = clampPercent(progress?.percent || 0);
  const currentProgressStep = progress?.step || status;
  const currentDetailIndex = progressDetailIndex(currentProgressStep, status);
  const liveStatusText = progress?.label
    ? progress.label
    : deferredFocus
      ? `本次会额外强调：${deferredFocus}`
      : '未设置额外强调点，将默认围绕论文主线进行改写。';

  return (
    <main className="workspace-shell">
      <section className="dashboard-hero">
        <div className="hero-copy">
          <div className="hero-chip">
            <Orbit className="h-4 w-4" />
            {APP_BADGE}
          </div>
          <p className="hero-kicker">{APP_KICKER}</p>
          <h1 className="font-display">{APP_TITLE}</h1>
          <p className="hero-description">
            {APP_DESCRIPTION}
          </p>
        </div>

        <div className="hero-stats">
          <HeroStat label="生成引擎" value={result?.diagnostics.llmUsed ? 'Moonshot' : '保底稿'} />
          <HeroStat label="论文页数" value={result ? `${result.file.pages}` : '--'} />
          <HeroStat label="导出格式" value={result ? 'HTML + DOCX' : '待生成'} />
        </div>
      </section>

      <div className="dashboard-grid">
        <aside className="dashboard-rail">
          <section className="dashboard-panel command-panel">
            <PanelHeading kicker="上传区" title="上传与控制" icon={<Upload className="h-5 w-5" />} />

            <button
              type="button"
              onDragOver={(event) => event.preventDefault()}
              onDrop={onDrop}
              onClick={() => inputRef.current?.click()}
              className={`dropzone ${file ? 'dropzone-ready' : ''}`}
            >
              <input ref={inputRef} type="file" accept="application/pdf" className="native-file-input" onChange={onFileChange} />
              <div className="dropzone-icon">
                <FileText className="h-6 w-6" />
              </div>
              <div>
                <p className="dropzone-title">{file ? file.name : '拖入论文 PDF'}</p>
                <p className="dropzone-copy">推荐上传带文字层的 PDF。扫描版会影响解析质量与期刊识别效果。</p>
              </div>
            </button>

            <div className="option-stack">
              <ControlBlock label="语气" value={tone} options={TONE_OPTIONS} onChange={setTone} />
              <ControlBlock label="读者" value={audience} options={AUDIENCE_OPTIONS} onChange={setAudience} />
              <ControlBlock label="线程长度" value={threadLength} options={THREAD_OPTIONS} onChange={setThreadLength} />
            </div>

            <label className="text-label">
              Kimi API 密钥
              <input
                type="password"
                value={kimiApiKey}
                onChange={(event) => setKimiApiKey(event.target.value)}
                placeholder="输入你自己的 Kimi 密钥"
                autoComplete="off"
                spellCheck={false}
                className="secret-input"
              />
              <span className="input-help">每次打开页面都需要手动输入；不会从后端读取，也不会写入仓库。</span>
            </label>

            <label className="text-label">
              传播重点
              <textarea
                value={focus}
                onChange={(event) => setFocus(event.target.value)}
                placeholder="例如：突出实验结果、压低术语密度、强调工程价值。"
                className="focus-input"
              />
            </label>

            {error ? <div className="error-banner">{error}</div> : null}

            <button
              type="button"
              onClick={onGenerate}
              className="launch-button"
              disabled={!kimiApiKey.trim() || status === 'uploading' || status === 'extracting' || status === 'writing'}
            >
              {status === 'uploading' || status === 'extracting' || status === 'writing' ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <Wand2 className="h-5 w-5" />
              )}
              生成线程与导出稿
            </button>
          </section>

        </aside>

        <section className="dashboard-main">
          <section className="dashboard-panel dashboard-status status-panel progress-primary-panel">
            <PanelHeading kicker="进度区" title="实时进度" icon={<ScanSearch className="h-5 w-5" />} />

            <div className="status-primary-grid">
              <div className="status-primary-hero">
                <div className="status-ring-shell">
                  <ProgressRing percent={percent} status={status} step={currentProgressStep} />
                  <div className="status-ring-copy">
                    <p className="section-kicker">实时摘要</p>
                    <p className="status-copy">{liveStatusText}</p>
                    <div className="flow-mini">
                      {FLOW_STEPS.map((step, index) => (
                        <span
                          key={step}
                          className={`flow-mini-pill ${isStepActive(status, index, progress?.step) ? 'flow-mini-pill-active' : ''}`}
                        >
                          {step}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>

                {progress?.detail ? <p className="progress-detail">{progress.detail}</p> : null}

                <div className="status-meta-grid">
                  <MetricMini label="阶段" value={progressStageLabel(progress?.step || status)} />
                  <MetricMini label="进度" value={`${percent}%`} />
                  <MetricMini label="状态" value={statusLabel(status)} />
                </div>
              </div>

              <div className="status-primary-stream">
                <div className="progress-detail-board">
                  <div className="progress-detail-board-header">
                    <p className="section-kicker">阶段拆解</p>
                    <span>{percent}%</span>
                  </div>
                  <div className="progress-detail-list">
                    {PROGRESS_DETAIL_STAGES.map(([stepKey, title, copy], index) => {
                      const itemState =
                        status === 'done'
                          ? 'done'
                          : index < currentDetailIndex
                            ? 'done'
                            : index === currentDetailIndex
                              ? status === 'error'
                                ? 'error'
                                : 'active'
                              : 'pending';

                      return (
                        <article key={stepKey} className={`progress-detail-item progress-detail-item-${itemState}`}>
                          <div className="progress-detail-index">{String(index + 1).padStart(2, '0')}</div>
                          <div className="progress-detail-copy">
                            <strong>{title}</strong>
                            <p>{copy}</p>
                          </div>
                          <span className="progress-detail-value">
                            {itemState === 'done' ? '完成' : itemState === 'active' ? `${percent}%` : '--'}
                          </span>
                        </article>
                      );
                    })}
                  </div>
                </div>

                <div className="progress-log">
                  <div className="progress-log-header">
                    <p className="section-kicker">实时日志</p>
                    <span>{progressHistory.length} 条</span>
                  </div>

                  {progressHistory.length ? (
                    <div className="progress-log-list">
                      {[...progressHistory].reverse().map((item) => (
                        <article key={item.id} className="progress-log-item">
                          <div className="progress-log-top">
                            <div className="progress-log-title">
                              <strong>{progressStageLabel(item.step || item.status)}</strong>
                              <em>{clampPercent(item.percent)}%</em>
                            </div>
                            <span>{formatProgressTime(item.updatedAt)}</span>
                          </div>
                          <p>{item.label}</p>
                          {item.detail ? <small>{item.detail}</small> : null}
                        </article>
                      ))}
                    </div>
                  ) : (
                    <div className="progress-log-empty">生成开始后，这里会实时打印解析和写作进度。</div>
                  )}
                </div>
              </div>
            </div>
          </section>

          <section className="dashboard-panel compact-export-panel">
            <div className="compact-export-header">
              <PanelHeading kicker="导出区" title="下载与报告" icon={<Download className="h-5 w-5" />} />
              {result ? (
                <div className="export-actions compact-export-actions">
                  <button
                    type="button"
                    onClick={() => downloadExport(result.export.htmlUrl, result.export.htmlFileName, 'html')}
                    className="action-pill action-pill-dark"
                    disabled={downloadingKey === 'html' || downloadingKey === 'docx'}
                  >
                    {downloadingKey === 'html' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUpRight className="h-4 w-4" />}
                    下载 HTML
                  </button>
                  <button
                    type="button"
                    onClick={() => downloadExport(result.export.docxUrl, result.export.fileName, 'docx')}
                    className="action-pill"
                    disabled={downloadingKey === 'html' || downloadingKey === 'docx'}
                  >
                    {downloadingKey === 'docx' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
                    下载 Word
                  </button>
                  <button type="button" onClick={() => copyText('post', editablePost)} className="action-pill">
                    <Copy className="h-4 w-4" />
                    {copiedKey === 'post' ? '已复制长稿' : '复制长稿'}
                  </button>
                </div>
              ) : null}
            </div>

            {result ? (
              <div className="compact-export-grid">
                <div className="hook-panel compact-hook-panel">
                  <p className="meta-line meta-line-light">开场钩子</p>
                  <p>{result.output.hook}</p>
                </div>
                <div className="diagnostic-box compact-diagnostic-box">
                  <p className="meta-line">诊断</p>
                  <div className="diagnostic-grid">
                    <span>识别章节：{result.diagnostics.sectionsFound.join(', ') || '未识别'}</span>
                    <span>生成方式：{result.diagnostics.llmUsed ? '大模型' : '保底稿'}</span>
                  </div>
                  {result.diagnostics.llmError ? <p className="diagnostic-warning">{result.diagnostics.llmError}</p> : null}
                </div>
              </div>
            ) : (
              <div className="results-placeholder-copy compact-export-placeholder">
                <div className="results-placeholder-pills">
                  <span>下载 HTML</span>
                  <span>下载 Word</span>
                  <span>运行诊断</span>
                </div>
              </div>
            )}
          </section>
        </section>
      </div>

      {result ? (
        <section className="result-stack result-stack-standalone">
          <section className="dashboard-panel">
            <PanelHeading kicker="解析结果" title="论文主线" icon={<Sparkles className="h-5 w-5" />} />

            <div className="paper-summary">
              <div className="title-block">
                <p className="meta-line">标题</p>
                <h3 className="font-display">{result.extracted.title}</h3>
                <p>{result.extracted.abstract}</p>
              </div>

              <div className="outline-list compact-outline-list">
                <article className="outline-panel">
                  <p className="meta-line">作者</p>
                  <p>{result.extracted.authors || '未稳定识别'}</p>
                </article>
                <article className="outline-panel">
                  <p className="meta-line">期刊 / 来源</p>
                  <p>{result.extracted.journal || '未稳定识别'}</p>
                </article>
                <article className="outline-panel">
                  <p className="meta-line">DOI</p>
                  <p>{result.extracted.doi || '未稳定识别'}</p>
                </article>
              </div>

              <div className="stats-grid">
                <MetricCard label="页数" value={`${result.file.pages}`} />
                <MetricCard label="段落" value={`${result.diagnostics.paragraphs}`} />
                <MetricCard label="字符" value={`${result.diagnostics.characters}`} />
              </div>

              <div className="keyword-band">
                <p className="meta-line">关键词</p>
                <div className="token-wrap">
                  {result.extracted.keywords.map((item) => (
                    <span key={item} className="token token-strong">
                      {item}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <div className="content-grid">
            <section className="dashboard-panel thread-panel">
              <PanelHeading kicker="线程稿" title="推文线程" icon={<PenSquare className="h-5 w-5" />} />

              <div className="thread-grid">
                {result.output.thread.map((tweet, index) => (
                  <article key={`${index}-${tweet.slice(0, 24)}`} className="thread-card">
                    <div className="thread-card-top">
                      <div>
                        <p className="meta-line">第 {index + 1} 条</p>
                        <p className="thread-index">0{index + 1}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => copyText(`tweet-${index}`, tweet)}
                        className="mini-copy"
                      >
                        <Copy className="h-4 w-4" />
                        {copiedKey === `tweet-${index}` ? '已复制' : '复制'}
                      </button>
                    </div>
                    <pre>{tweet}</pre>
                  </article>
                ))}
              </div>
            </section>

            <section className="dashboard-panel longform-panel">
              <PanelHeading kicker="长稿区" title="长文稿" icon={<Hash className="h-5 w-5" />} />

              <div className="token-wrap compact-token-wrap">
                {result.output.hashtags.map((tag) => (
                  <span key={tag} className="token">
                    {tag}
                  </span>
                ))}
              </div>
              <textarea
                value={editablePost}
                onChange={(event) => setEditablePost(event.target.value)}
                className="longform-editor"
              />
            </section>

            <section className="dashboard-panel preview-panel">
              <PanelHeading kicker="版式预览" title="HTML / Word 预览" icon={<ArrowUpRight className="h-5 w-5" />} />

              <iframe
                title="HTML 导出预览"
                className="preview-frame"
                srcDoc={getPreviewDocument(result.output.previewHtml)}
              />
            </section>
          </div>
        </section>
      ) : null}
    </main>
  );
}

function flowIndexForState(status: Status, progressStep?: string) {
  if (progressStep) {
    if (progressStep.startsWith('llm')) {
      return 2;
    }

    switch (progressStep) {
      case 'received':
      case 'queued':
        return 0;
      case 'parsing':
      case 'structuring':
        return 1;
      case 'fallback':
        return 2;
      case 'rendering':
      case 'completed':
        return 3;
      case 'failed':
        return 2;
      default:
        break;
    }
  }

  const order = {
    idle: -1,
    uploading: 0,
    extracting: 1,
    writing: 2,
    done: 3,
    error: 2
  };

  return order[status];
}

function isStepActive(status: Status, index: number, progressStep?: string) {
  return index <= flowIndexForState(status, progressStep);
}

function progressStageLabel(step: string) {
  switch (step) {
    case 'idle':
      return '待开始';
    case 'uploading':
      return '接收文件';
    case 'extracting':
      return '解析中';
    case 'writing':
      return '生成中';
    case 'queued':
    case 'received':
      return '上传';
    case 'parsing':
      return '解析 PDF';
    case 'structuring':
      return '整理结构';
    case 'llm':
    case 'llm-thread':
      return '生成线程';
    case 'llm-article':
      return '生成长稿';
    case 'llm-expand':
      return '补长正文';
    case 'llm-post':
      return '补全文稿';
    case 'fallback':
      return '保底生成';
    case 'rendering':
      return '导出文件';
    case 'completed':
      return '完成';
    case 'failed':
      return '失败';
    default:
      return step || '处理中';
  }
}

function progressDetailIndex(step: string, status: Status) {
  if (status === 'done') {
    return PROGRESS_DETAIL_STAGES.length;
  }

  switch (step) {
    case 'queued':
    case 'received':
      return 0;
    case 'parsing':
      return 1;
    case 'structuring':
      return 2;
    case 'llm-read':
      return 3;
    case 'llm-draft':
    case 'llm':
    case 'llm-thread':
      return 4;
    case 'llm-article':
    case 'llm-post':
    case 'llm-expand':
    case 'fallback':
      return 5;
    case 'rendering':
    case 'completed':
      return 6;
    case 'failed':
      return Math.max(0, PROGRESS_DETAIL_STAGES.length - 1);
    default:
      return status === 'idle' ? -1 : 0;
  }
}

function resolveBackendUrl(path: string) {
  if (!path) {
    return BACKEND_ORIGIN;
  }

  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  return `${BACKEND_ORIGIN}${path.startsWith('/') ? path : `/${path}`}`;
}

function normalizeResultUrls(result: GenerationResponse): GenerationResponse {
  return {
    ...result,
    export: {
      ...result.export,
      docxUrl: resolveBackendUrl(result.export.docxUrl),
      htmlUrl: resolveBackendUrl(result.export.htmlUrl)
    }
  };
}

async function fetchResultByProgressId(progressId: string) {
  const response = await fetch(resolveBackendUrl(`/api/result/${progressId}`), {
    cache: 'no-store'
  });

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error('RESULT_NOT_READY');
    }
    throw new Error(`结果回填失败（HTTP ${response.status}）`);
  }

  const data = (await response.json()) as GenerationResponse;
  if (!data.output || !data.export) {
    throw new Error('服务返回格式异常，请重试。');
  }

  return normalizeResultUrls(data);
}

async function recoverCompletedResult(progressId: string) {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < RESULT_RECOVERY_RETRIES; attempt += 1) {
    try {
      return await fetchResultByProgressId(progressId);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (message !== 'RESULT_NOT_READY') {
        throw error;
      }

      if (attempt < RESULT_RECOVERY_RETRIES - 1) {
        await new Promise((resolve) => window.setTimeout(resolve, RESULT_RECOVERY_DELAY_MS));
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('结果暂未就绪');
}

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, Math.round(value || 0)));
}

function startProgressPolling(
  progressId: string,
  onUpdate: (next: GenerationProgress) => void,
  onTerminal?: (next: GenerationProgress) => void | Promise<void>
) {
  let active = true;
  let timer: number | null = null;

  const poll = async () => {
    if (!active) {
      return;
    }

    try {
      const response = await fetch(resolveBackendUrl(`/api/progress/${progressId}`), {
        cache: 'no-store'
      });

      if (response.ok) {
        const snapshot = (await response.json()) as GenerationProgress;
        onUpdate(snapshot);

        if (snapshot.status === 'done' || snapshot.status === 'error') {
          active = false;
          if (onTerminal) {
            void onTerminal(snapshot);
          }
          return;
        }
      }
    } catch (_error) {
      // Ignore polling errors and keep retrying while the main request is alive.
    }

    if (active) {
      timer = window.setTimeout(poll, 800);
    }
  };

  void poll();

  return () => {
    active = false;
    if (timer !== null) {
      window.clearTimeout(timer);
    }
  };
}

function formatProgressTime(value?: string) {
  if (!value) {
    return '--:--';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '--:--';
  }

  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(date);
}

function statusLabel(status: Status) {
  switch (status) {
    case 'idle':
      return '待命';
    case 'uploading':
      return '上传中';
    case 'extracting':
      return '解析中';
    case 'writing':
      return '生成中';
    case 'done':
      return '已完成';
    case 'error':
      return '失败';
    default:
      return status;
  }
}

function PanelHeading({
  kicker,
  title,
  icon
}: {
  kicker: string;
  title: string;
  icon: ReactNode;
}) {
  return (
    <div className="panel-header">
      <div>
        <p className="section-kicker">{kicker}</p>
        <h2 className="font-display">{title}</h2>
      </div>
      <div className="panel-icon">{icon}</div>
    </div>
  );
}

function HeroStat({ label, value }: { label: string; value: string }) {
  return (
    <article className="hero-stat">
      <p className="meta-line">{label}</p>
      <p className="hero-stat-value">{value}</p>
    </article>
  );
}

function MetricMini({ label, value }: { label: string; value: string }) {
  return (
    <article className="metric-mini">
      <p className="meta-line">{label}</p>
      <p className="metric-mini-value">{value}</p>
    </article>
  );
}

function ProgressRing({ percent, status, step }: { percent: number; status: Status; step: string }) {
  const normalized = clampPercent(percent);
  const radius = 84;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (normalized / 100) * circumference;

  return (
    <div className="progress-ring">
      <svg viewBox="0 0 200 200" className="progress-ring-svg" aria-hidden="true">
        <circle className="progress-ring-track" cx="100" cy="100" r={radius} />
        <circle
          className={`progress-ring-bar progress-ring-bar-${status}`}
          cx="100"
          cy="100"
          r={radius}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      </svg>
      <div className="progress-ring-content">
        <strong>{normalized}%</strong>
        <span>{statusLabel(status)}</span>
        <small>{progressStageLabel(status === 'done' ? 'completed' : status === 'error' ? 'failed' : step)}</small>
      </div>
    </div>
  );
}

function ControlBlock({
  label,
  value,
  options,
  onChange
}: {
  label: string;
  value: string;
  options: readonly (readonly [string, string])[];
  onChange: (next: string) => void;
}) {
  return (
    <div className="control-block">
      <p className="text-label">{label}</p>
      <div className="option-wrap">
        {options.map(([optionValue, optionLabel]) => (
          <button
            key={optionValue}
            type="button"
            onClick={() => onChange(optionValue)}
            className={`option-chip ${value === optionValue ? 'option-chip-active' : ''}`}
          >
            {optionLabel}
          </button>
        ))}
      </div>
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric-card">
      <p className="meta-line">{label}</p>
      <p className="metric-value">{value}</p>
    </div>
  );
}

function EmptyState({
  icon,
  title,
  description
}: {
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="empty-state">
      <div className="empty-state-icon">{icon}</div>
      <h3 className="font-display">{title}</h3>
      <p>{description}</p>
    </div>
  );
}
