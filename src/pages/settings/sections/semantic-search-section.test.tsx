import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SemanticSearchSection } from './semantic-search-section'

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

describe('SemanticSearchSection — provider connection settings reuse', () => {
  it('shows the reused Ollama base URL as read-only and points at the AI Providers section', () => {
    swrData['/api/settings/search-embedding'] = baseStatus({ base_url: 'http://10.8.0.1:11434' })
    render(<SemanticSearchSection t={t} settings={{} as never} />)

    // The reused value is displayed...
    expect(screen.getByText('http://10.8.0.1:11434')).toBeTruthy()
    // ...with a pointer to the LLM provider section instead of an editable field.
    expect(screen.getByText('settings.semanticBaseUrlReused')).toBeTruthy()
    // No editable input carries the base URL value.
    expect(screen.queryByDisplayValue('http://10.8.0.1:11434')).toBeNull()
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

  it('keeps the OpenAI gateway override editable (no LLM-side base URL exists to reuse)', () => {
    swrData['/api/settings/search-embedding'] = baseStatus({
      provider: 'openai',
      model: 'text-embedding-3-small',
      base_url: 'https://openrouter.ai/api/v1',
      api_key_configured: true,
    })
    render(<SemanticSearchSection t={t} settings={{} as never} />)

    expect(screen.getByDisplayValue('https://openrouter.ai/api/v1')).toBeTruthy()
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
})
