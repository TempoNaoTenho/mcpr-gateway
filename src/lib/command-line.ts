type TokenState = {
  quote: '"' | "'" | null
  escaping: boolean
  current: string
  tokens: string[]
}

function pushCurrent(state: TokenState): void {
  if (state.current.length === 0) return
  state.tokens.push(state.current)
  state.current = ''
}

export function splitCommandLine(commandLine: string): string[] {
  const trimmed = commandLine.trim()
  if (trimmed.length === 0) return []

  const state: TokenState = {
    quote: null,
    escaping: false,
    current: '',
    tokens: [],
  }

  for (const char of trimmed) {
    if (state.escaping) {
      state.current += char
      state.escaping = false
      continue
    }

    if (char === '\\') {
      state.escaping = true
      continue
    }

    if (state.quote) {
      if (char === state.quote) {
        state.quote = null
      } else {
        state.current += char
      }
      continue
    }

    if (char === '"' || char === "'") {
      state.quote = char
      continue
    }

    if (/\s/.test(char)) {
      pushCurrent(state)
      continue
    }

    state.current += char
  }

  if (state.escaping) {
    state.current += '\\'
  }

  pushCurrent(state)
  return state.tokens
}
