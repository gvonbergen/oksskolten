import { useCallback, useEffect, useMemo, useState } from 'react'
import useSWR from 'swr'
import { fetcher, apiPost, apiPatch } from '../../../lib/fetcher'
import { Input } from '@/components/ui/input'
import { FormField } from '@/components/ui/form-field'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { ShieldCheck, ShieldAlert, RefreshCw, Info } from 'lucide-react'
import {
  EMBEDDING_MODELS,
  EMBEDDING_DEFAULT_MODELS,
  type EmbeddingProvider,
  type EmbeddingModelDef,
} from '../../../data/aiModels'

type TFunc = (key: any, params?: Record<string, string>) => string

interface EmbeddingStatus {
  enabled: 'on' | 'off'
  provider: EmbeddingProvider | null
  model: string | null
  dimensions: number | null
  base_url: string | null
  api_key_configured: boolean
  prerequisite: {
    met: boolean
    autoSummaryEnabled: boolean
    summaryProvider: string | null
    summaryModel: string | null
    reason: string | null
  }
  semantic_ready: boolean
  rebuilding: boolean
  last_rebuild: { startedAt: number; finishedAt: number | null; ok: boolean | null; error: string | null; documents: number | null; processedDocuments?: number; totalDocuments?: number | null } | null
  index: { documents: number | null; embeddedDocuments: number | null; embeddings: number | null } | null
}

const OLLAMA_DEFAULT_URL = 'http://localhost:11434'

export function SemanticSearchSection({ t }: { t: TFunc }) {
  const { data: status, mutate } = useSWR<EmbeddingStatus>(
    '/api/settings/search-embedding',
    fetcher,
    { revalidateOnFocus: false },
  )

  const enabled = status?.enabled === 'on'
  const rebuilding = status?.rebuilding ?? false

  // Poll while something is in flight so backfill progress / readiness
  // shows up without a manual refresh.
  const refreshInterval = enabled || rebuilding ? 5000 : 0
  useEffect(() => {
    if (refreshInterval === 0) return
    const timer = setInterval(() => { void mutate() }, refreshInterval)
    return () => clearInterval(timer)
  }, [mutate, refreshInterval])

  // Local form state (initialized from server once)
  const [provider, setProvider] = useState<EmbeddingProvider | null>(null)
  const [modelInput, setModelInput] = useState('')
  const [dimensionsInput, setDimensionsInput] = useState('')
  const [baseUrlInput, setBaseUrlInput] = useState('')
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [initialized, setInitialized] = useState(false)
  useEffect(() => {
    if (!status || initialized) return
    setProvider(status.provider)
    setModelInput(status.model || '')
    setDimensionsInput(status.dimensions ? String(status.dimensions) : '')
    setBaseUrlInput(status.base_url || '')
    setApiKeyInput('')
    setInitialized(true)
  }, [status, initialized])

  const [message, setMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [rebuildConfirm, setRebuildConfirm] = useState(false)

  function showMessage(text: string, type: 'success' | 'error') {
    setMessage({ text, type })
    setTimeout(() => setMessage(null), 5000)
  }

  const selectedModel = provider ? EMBEDDING_MODELS[provider] : null

  const hasChanges = useMemo(() => {
    if (!status) return false
    const dims = dimensionsInput === '' ? null : Number(dimensionsInput)
    return (
      provider !== status.provider ||
      modelInput !== (status.model || '') ||
      dims !== status.dimensions ||
      baseUrlInput !== (status.base_url || '')
    )
  }, [status, provider, modelInput, dimensionsInput, baseUrlInput])

  const handleEnable = useCallback(async (value: 'on' | 'off') => {
    if (saving) return
    setSaving(true)
    try {
      await apiPatch('/api/settings/search-embedding', { enabled: value })
      setMessage(null)
      void mutate()
      showMessage(value === 'on' ? t('settings.semanticSaved') : t('settings.saved'), 'success')
    } catch (err: unknown) {
      showMessage(err instanceof Error ? err.message : 'Save failed', 'error')
    } finally {
      setSaving(false)
    }
  }, [saving, mutate, t])

  const handleSaveConfig = useCallback(async () => {
    if (saving) return
    setSaving(true)
    setMessage(null)
    setTestResult(null)
    try {
      await apiPatch('/api/settings/search-embedding', {
        provider: provider ?? '',
        model: modelInput,
        dimensions: dimensionsInput,
        base_url: baseUrlInput,
      })
      void mutate()
      showMessage(t('settings.semanticSaved'), 'success')
    } catch (err: unknown) {
      showMessage(err instanceof Error ? err.message : 'Save failed', 'error')
    } finally {
      setSaving(false)
    }
  }, [saving, provider, modelInput, dimensionsInput, baseUrlInput, mutate, t])

  const handleSaveKey = useCallback(async () => {
    if (saving) return
    setSaving(true)
    try {
      await apiPost('/api/settings/search-embedding/key', { apiKey: apiKeyInput })
      setApiKeyInput('')
      setMessage(null)
      void mutate()
      showMessage(t('settings.semanticApiKeySaved'), 'success')
    } catch (err: unknown) {
      showMessage(err instanceof Error ? err.message : 'Save failed', 'error')
    } finally {
      setSaving(false)
    }
  }, [saving, apiKeyInput, mutate, t])

  const handleDeleteKey = useCallback(async () => {
    if (saving) return
    setSaving(true)
    try {
      await apiPost('/api/settings/search-embedding/key', { apiKey: '' })
      void mutate()
      showMessage(t('settings.semanticApiKeyDeleted'), 'success')
    } catch (err: unknown) {
      showMessage(err instanceof Error ? err.message : 'Save failed', 'error')
    } finally {
      setSaving(false)
    }
  }, [saving, mutate, t])

  const handleTest = useCallback(async () => {
    if (testing) return
    setTesting(true)
    setTestResult(null)
    try {
      const body: Record<string, unknown> = {}
      if (provider) body.provider = provider
      if (modelInput) body.model = modelInput
      if (dimensionsInput) body.dimensions = Number(dimensionsInput)
      if (baseUrlInput) body.base_url = baseUrlInput
      if (apiKeyInput) body.apiKey = apiKeyInput
      const res = await apiPost('/api/settings/search-embedding/test', body) as { ok: boolean; model?: string; dimensions?: number }
      setTestResult({ ok: true, text: t('settings.semanticTestOk', { model: res.model || '', dimensions: String(res.dimensions ?? '') }) })
    } catch (err: unknown) {
      const fallback = err instanceof Error ? err.message : 'Test failed'
      setTestResult({ ok: false, text: fallback })
    } finally {
      setTesting(false)
    }
  }, [testing, provider, modelInput, dimensionsInput, baseUrlInput, apiKeyInput, t])

  const handleRebuild = useCallback(async () => {
    setRebuildConfirm(false)
    try {
      await apiPost('/api/settings/search-embedding/rebuild')
      void mutate()
      showMessage(t('settings.semanticRebuildStarted'), 'success')
    } catch (err: unknown) {
      showMessage(err instanceof Error ? err.message : 'Rebuild failed', 'error')
    }
  }, [mutate, t])

  const prerequisite = status?.prerequisite
  const prerequisiteUnmet = !prerequisite?.met
  const ready = status?.semantic_ready ?? false
  const index = status?.index
  const lastError = status?.last_rebuild && status.last_rebuild.ok === false ? status.last_rebuild.error : null
  const rebuildProgress = lastRebuildProgress(status?.last_rebuild)

  const privacyUrl = provider === 'ollama' ? (baseUrlInput || OLLAMA_DEFAULT_URL) : ''

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-text mb-1">{t('settings.semanticSearch')}</h2>
        <p className="text-xs text-muted">{t('settings.semanticSearchDesc')}</p>
      </div>

      {/* Dependency explanation */}
      {prerequisiteUnmet && enabled && (
        <div className="flex items-start gap-2 rounded-md bg-bg-subtle px-3 py-2 text-xs text-muted">
          <ShieldAlert size={14} className="shrink-0 mt-0.5 text-warning" />
          <span>{prerequisite?.reason || t('settings.semanticDependencyNote')}</span>
        </div>
      )}
      {prerequisiteUnmet && !enabled && (
        <div className="flex items-start gap-2 rounded-md bg-bg-subtle px-3 py-2 text-xs text-muted">
          <Info size={14} className="shrink-0 mt-0.5 text-accent" />
          <span>{prerequisite?.reason || t('settings.semanticDependencyNote')}</span>
        </div>
      )}

      {/* Enable toggle */}
      <div>
        <p className="text-sm text-text mb-1">{t('settings.semanticEnable')}</p>
        <div className="flex rounded-md bg-bg-subtle p-0.5 w-fit">
          {(['on', 'off'] as const).map(opt => (
            <button
              key={opt}
              type="button"
              onClick={() => handleEnable(opt)}
              disabled={saving || rebuilding || (opt === 'on' && (prerequisiteUnmet || apiKeyMissingForOpenai(status, provider, apiKeyInput)))}
              aria-pressed={enabled === (opt === 'on')}
              className={`px-3 py-1.5 text-xs rounded transition-colors select-none disabled:opacity-40 ${
                enabled === (opt === 'on')
                  ? 'bg-accent text-accent-text font-medium shadow-sm'
                  : 'text-muted hover:text-text'
              }`}
            >
              {opt === 'on' ? t('settings.semanticEnableOn') : t('settings.semanticEnableOff')}
            </button>
          ))}
        </div>
        {enabled && ready && (
          <p className="mt-1.5 text-xs text-accent flex items-center gap-1.5">
            <ShieldCheck size={13} /> {t('settings.semanticReady')}
          </p>
        )}
        {enabled && !ready && (
          <p className="mt-1.5 text-xs text-muted flex items-center gap-1.5">
            <Info size={13} /> {t('settings.semanticNotReady')}
            {prerequisiteUnmet && prerequisite?.reason ? ` — ${prerequisite.reason}` : ''}
          </p>
        )}
      </div>

      {/* Configuration */}
      <>
          {/* Privacy warning — shown before/with activation, provider-specific */}
          {provider === 'openai' && (
            <div className="flex items-start gap-2 rounded-md bg-bg-card border border-border px-3 py-2 text-xs text-muted">
              <ShieldAlert size={14} className="shrink-0 mt-0.5 text-warning" />
              <span>{t('settings.semanticPrivacyCloud', { provider: 'OpenAI' })}</span>
            </div>
          )}
          {provider === 'ollama' && (
            <div className="flex items-start gap-2 rounded-md bg-bg-card border border-border px-3 py-2 text-xs text-muted">
              <ShieldCheck size={14} className="shrink-0 mt-0.5 text-success" />
              <span>{t('settings.semanticPrivacyLocal', { url: privacyUrl })}</span>
            </div>
          )}

          <div className="p-3 rounded-lg bg-bg-card border border-border space-y-3">
            <div>
              <span className="block text-xs font-medium text-text mb-1.5 select-none">{t('settings.semanticProvider')}</span>
              <div className="flex rounded-md bg-bg-subtle p-0.5">
                {(['openai', 'ollama'] as EmbeddingProvider[]).map(p => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => {
                      setProvider(p)
                      const def = EMBEDDING_DEFAULT_MODELS[p]
                      setModelInput(prev => (provider === p ? prev : prev || def))
                    }}
                    className={`flex-1 px-1.5 py-1 text-[11px] rounded transition-colors select-none ${
                      provider === p ? 'bg-accent text-accent-text font-medium shadow-sm' : 'text-muted hover:text-text'
                    }`}
                  >
                    {p === 'openai' ? t('settings.semanticProviderOpenai') : t('settings.semanticProviderOllama')}
                  </button>
                ))}
              </div>
            </div>

            <FormField label={t('settings.semanticModel')} hint={t('settings.semanticModelHint')} compact>
              {provider === 'openai' && selectedModel ? (
                <select
                  value={modelInput}
                  onChange={e => setModelInput(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-xs rounded-lg border border-border bg-bg-card text-text focus:outline-none focus:ring-1 focus:ring-accent"
                >
                  {selectedModel.map((m: EmbeddingModelDef) => (
                    <option key={m.value} value={m.value}>{m.label} ({m.dimensions}d)</option>
                  ))}
                </select>
              ) : (
                <Input
                  type="text"
                  value={modelInput}
                  onChange={e => setModelInput(e.target.value)}
                  placeholder={EMBEDDING_DEFAULT_MODELS.ollama}
                  className="py-1.5"
                />
              )}
            </FormField>

            <FormField label={t('settings.semanticDimensions')} hint={t('settings.semanticDimensionsDesc')} compact>
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={8192}
                value={dimensionsInput}
                onChange={e => setDimensionsInput(e.target.value)}
                placeholder={provider ? String(selectedModel?.find(m => m.value === modelInput)?.dimensions ?? '') : ''}
                className="w-28 py-1.5"
              />
            </FormField>

            <FormField label={t('settings.semanticBaseUrl')} hint={t('settings.semanticBaseUrlDesc')} compact>
              <Input
                type="text"
                value={baseUrlInput}
                onChange={e => setBaseUrlInput(e.target.value)}
                placeholder={provider === 'openai' ? 'https://api.openai.com/v1' : OLLAMA_DEFAULT_URL}
                className="py-1.5"
              />
            </FormField>

            {/* Distinct embedding credential (never returned by the server) */}
            <div className="pt-1 border-t border-border">
              <FormField label={t('settings.semanticApiKey')} compact>
                <div className="flex items-center gap-2">
                  <Input
                    type="password"
                    value={apiKeyInput}
                    onChange={e => setApiKeyInput(e.target.value)}
                    placeholder={status?.api_key_configured ? '••••••••' : provider === 'openai' ? 'sk-...' : '...'}
                    className="flex-1 py-1.5"
                  />
                  {apiKeyInput && (
                    <button
                      type="button"
                      onClick={handleSaveKey}
                      disabled={saving || rebuilding}
                      className="px-3 py-1.5 text-xs font-medium rounded-lg bg-accent text-accent-text hover:opacity-90 transition-opacity disabled:opacity-50 select-none shrink-0"
                    >
                      {t('settings.semanticSave')}
                    </button>
                  )}
                  {status?.api_key_configured && (
                    <span className="text-xs text-success whitespace-nowrap select-none">{t('settings.semanticApiKeyConfigured')}</span>
                  )}
                  {status?.api_key_configured && !apiKeyInput && (
                    <button
                      type="button"
                      onClick={handleDeleteKey}
                      disabled={saving || rebuilding}
                      className="px-3 py-1.5 text-xs rounded-lg border border-border text-muted hover:text-text hover:bg-hover transition-colors disabled:opacity-50 select-none shrink-0"
                    >
                      {t('settings.semanticApiKeyDelete')}
                    </button>
                  )}
                </div>
              </FormField>
              {provider === 'openai' && !status?.api_key_configured && (
                <p className="text-[11px] text-muted/80 mt-1">{t('settings.semanticOpenaiKeyRequired')}</p>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-border">
              {hasChanges && (
                <button
                  type="button"
                  onClick={handleSaveConfig}
                  disabled={saving || rebuilding}
                  className="px-3 py-1.5 text-xs font-medium rounded-lg bg-accent text-accent-text hover:opacity-90 transition-opacity disabled:opacity-50 select-none"
                >
                  {saving ? '...' : t('settings.semanticSave')}
                </button>
              )}
              <button
                type="button"
                onClick={handleTest}
                disabled={testing || !provider || !modelInput}
                className="px-3 py-1.5 text-xs rounded-lg border border-border text-muted hover:text-text hover:bg-hover transition-colors disabled:opacity-50 select-none"
              >
                {testing ? t('settings.semanticTesting') : t('settings.semanticTestConnection')}
              </button>
              <button
                type="button"
                onClick={() => setRebuildConfirm(true)}
                disabled={rebuilding}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-border text-muted hover:text-text hover:bg-hover transition-colors disabled:opacity-50 select-none"
              >
                <RefreshCw size={12} className={rebuilding ? 'animate-spin' : ''} />
                {t('settings.semanticRebuildButton')}
              </button>
              {testResult && (
                <span className={`text-xs ${testResult.ok ? 'text-accent' : 'text-error'}`}>{testResult.text}</span>
              )}
            </div>

            {/* Readiness / progress / errors */}
            <div className="rounded-md bg-bg-subtle px-3 py-2 text-xs text-muted space-y-1">
              {rebuilding && (
                <>
                  <p className="flex items-center gap-1.5 text-accent"><RefreshCw size={12} className="animate-spin" /> {t('settings.semanticRebuilding')}</p>
                  {rebuildProgress && (
                    <p>{t('settings.semanticRebuildProgress', rebuildProgress)}</p>
                  )}
                </>
              )}
              {!rebuilding && index != null && index.documents != null && (
                <p>
                  {t('settings.semanticEmbeddedProgress', {
                    embedded: String(index.embeddedDocuments ?? 0),
                    documents: String(index.documents),
                  })}
                </p>
              )}
              {lastError && (
                <p className="text-error">
                  {t('settings.semanticLastRebuildFailed', { error: lastError })}
                </p>
              )}
            </div>
          </div>
        </>

      {message && (
        <p className={`text-xs ${message.type === 'error' ? 'text-error' : 'text-accent'}`}>{message.text}</p>
      )}

      {rebuildConfirm && (
        <ConfirmDialog
          title={t('settings.semanticRebuildButton')}
          message={t('settings.semanticRebuildConfirm')}
          danger
          onConfirm={handleRebuild}
          onCancel={() => setRebuildConfirm(false)}
        />
      )}
    </section>
  )
}

function lastRebuildProgress(lastRebuild: EmbeddingStatus['last_rebuild']): { processed: string; total: string } | null {
  if (!lastRebuild || lastRebuild.totalDocuments == null) return null
  return {
    processed: String(lastRebuild.processedDocuments ?? 0),
    total: String(lastRebuild.totalDocuments),
  }
}

function apiKeyMissingForOpenai(status: EmbeddingStatus | undefined, provider: EmbeddingProvider | null, apiKeyInput: string): boolean {
  return provider === 'openai' && !status?.api_key_configured && !apiKeyInput
}