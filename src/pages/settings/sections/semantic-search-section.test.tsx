import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SemanticSearchSection } from './semantic-search-section'
import { apiPatch } from '../../../lib/fetcher'

// --- Mocks ---

vi.mock('../../../lib/fetcher', () => ({
  fetcher: vi.fn(),
  apiPatch: vi.fn(),
  apiPost: vi.fn(),
}))

const swrData: Record<string, unknown> = {}
const mockMutate = vi.fn()

vi.mock('swr', () => ({
  default: (key: string | null) => ({
    data: key ? swrData[key] ?? undefined : undefined,
    mutate: mockMutate,
  }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  for (const key of Object.keys(swrData)) delete swrData[key]
})

const t = ((key: unknown) => String(key)) as unknown as Parameters<typeof SemanticSearchSection>[0]['t']

function baseStatus(overrides: Record<string, unknown> = {}) {
  return {
    enabled: 'off',
    provider: 'ollama',
    model: 'nomic-embed-text',
    dimensions: null,
    base_url: null,
    api_key_configured: false,
    prerequisite: { met: true, autoSummaryEnabled: true, summaryProvider: 'ollama', summaryModel: 'llama3.2:latest', reason: null },
    semantic_ready: false,
    rebuilding: false,
    last_rebuild: null,
    index: null,
    ...overrides,
  }
}

describe('SemanticSearchSection — no base-URL configuration', () => {
  it('renders no base-URL field, label, input or helper text for Ollama', () => {
    swrData['/api/settings/search-embedding'] = baseStatus({ base_url: 'http://10.8.0.1:11434' })
    render(<SemanticSearchSection t={t} settings={{} as never} />)

    // The base-URL field, its label, its descriptions and the reused-value
    // helper text must be gone entirely for every provider.
    expect(screen.queryByText('settings.semanticBaseUrl')).toBeNull()
    expect(screen.queryByText('settings.semanticBaseUrlDesc')).toBeNull()
    expect(screen.queryByText('settings.semanticBaseUrlReused')).toBeNull()
    // No input (editable or disabled) carries the reused Ollama address.
    expect(screen.queryByDisplayValue('http://10.8.0.1:11434')).toBeNull()
    expect(screen.queryByPlaceholderText('https://api.openai.com/v1')).toBeNull()
  })

  it('renders no base-URL field for OpenAI even when a stale base_url exists in status', () => {
    swrData['/api/settings/search-embedding'] = baseStatus({
      provider: 'openai',
      model: 'text-embedding-3-small',
      base_url: 'https://openrouter.ai/api/v1',
      api_key_configured: true,
    })
    render(<SemanticSearchSection t={t} settings={{} as never} />)

    expect(screen.queryByText('settings.semanticBaseUrl')).toBeNull()
    expect(screen.queryByText('settings.semanticBaseUrlDesc')).toBeNull()
    expect(screen.queryByDisplayValue('https://openrouter.ai/api/v1')).toBeNull()
  })

  it('never sends a base_url in the save body, including after a provider switch', () => {
    swrData['/api/settings/search-embedding'] = baseStatus({ base_url: 'http://10.8.0.1:11434' })
    render(<SemanticSearchSection t={t} settings={{} as never} />)

    fireEvent.click(screen.getByText('settings.semanticProviderOpenai'))
    fireEvent.click(screen.getByText('settings.semanticSave'))

    expect(apiPatch).toHaveBeenCalledWith('/api/settings/search-embedding', expect.objectContaining({
      provider: 'openai',
      model: 'text-embedding-3-small',
    }))
    expect(JSON.stringify(vi.mocked(apiPatch).mock.calls[0][1])).not.toContain('base_url')
  })

  it('does not render a second API key input for OpenAI — the reused credential is reported instead', () => {
    swrData['/api/settings/search-embedding'] = baseStatus({
      provider: 'openai',
      model: 'text-embedding-3-small',
      api_key_configured: true,
    })
    render(<SemanticSearchSection t={t} settings={{} as never} />)

    expect(screen.getByText('settings.semanticApiKeyReused')).toBeTruthy()
    expect(screen.queryByPlaceholderText('sk-...')).toBeNull()
    expect(screen.queryByLabelText(/api key/i)).toBeNull()
  })

  it('points the operator at AI Providers when no OpenAI credential exists', () => {
    swrData['/api/settings/search-embedding'] = baseStatus({
      provider: 'openai',
      model: 'text-embedding-3-small',
      api_key_configured: false,
    })
    render(<SemanticSearchSection t={t} settings={{} as never} />)

    expect(screen.getByText('settings.semanticApiKeyReuseMissing')).toBeTruthy()
    expect(screen.queryByPlaceholderText('sk-...')).toBeNull()
  })

  it('keeps the provider-specific privacy warnings', () => {
    swrData['/api/settings/search-embedding'] = baseStatus({ base_url: 'http://10.8.0.1:11434' })
    const { unmount } = render(<SemanticSearchSection t={t} settings={{} as never} />)
    expect(screen.getByText('settings.semanticPrivacyLocal')).toBeTruthy()
    unmount()

    swrData['/api/settings/search-embedding'] = baseStatus({ provider: 'openai', model: 'text-embedding-3-small', api_key_configured: true })
    render(<SemanticSearchSection t={t} settings={{} as never} />)
    expect(screen.getByText('settings.semanticPrivacyCloud')).toBeTruthy()
  })

  it('keeps unsaved model edits when clicking the already-active provider tab', () => {
    swrData['/api/settings/search-embedding'] = baseStatus({
      provider: 'ollama',
      model: 'nomic-embed-text',
      base_url: 'http://10.8.0.1:11434',
    })
    render(<SemanticSearchSection t={t} settings={{} as never} />)

    // Type an unsaved model edit.
    const modelField = screen.getByDisplayValue('nomic-embed-text')
    fireEvent.change(modelField, { target: { value: 'another-model' } })
    expect(screen.getByDisplayValue('another-model')).toBeTruthy()

    // Clicking the already-active 'ollama' tab must not discard the edit.
    fireEvent.click(screen.getByText('settings.semanticProviderOllama'))
    fireEvent.click(screen.getByText('settings.semanticSave'))

    expect(apiPatch).toHaveBeenCalledWith('/api/settings/search-embedding', expect.objectContaining({
      provider: 'ollama',
      model: 'another-model',
    }))
    // No base URL is ever part of the payload.
    expect(JSON.stringify(vi.mocked(apiPatch).mock.calls[0][1])).not.toContain('base_url')
  })
})