/* Model providers.
 *
 * The agent depends on this interface, not on any vendor. That matters for two
 * reasons: the loop can be tested end to end without a network or a key, and
 * swapping models is a flag rather than a rewrite.
 *
 *   provider.complete({ system, messages }) -> string
 *
 * `messages` is [{role: "user"|"assistant", content: string}].
 */

export class MockProvider {
  /**
   * Scripted responses for tests: a map of question -> array of replies, served
   * in order. The whole point is that the repair loop can be exercised
   * deterministically — reply 1 is broken, reply 2 fixes it — without spending
   * money or depending on a model behaving a particular way today.
   */
  constructor(script = {}, fallback = 'SELECT 1') {
    this.script = script;
    this.fallback = fallback;
    this.calls = [];
  }

  async complete({ system, messages }) {
    this.calls.push({ system, messages });
    const first = messages.find((m) => m.role === 'user');
    const key = Object.keys(this.script).find((k) => first && first.content.includes(k));
    if (!key) return this.fallback;
    const replies = this.script[key];
    const used = this.calls.filter((c) => {
      const u = c.messages.find((m) => m.role === 'user');
      return u && u.content.includes(key);
    }).length;
    return replies[Math.min(used - 1, replies.length - 1)];
  }
}

/* The official SDK is loaded on demand so the evaluation harness itself keeps
 * zero runtime dependencies — `npm test` needs nothing installed. */
export class AnthropicProvider {
  constructor(opts = {}) {
    this.model = opts.model || 'claude-opus-5-5';
    this.effort = opts.effort || 'medium';
    this.maxTokens = opts.maxTokens || 4096;
    this._client = null;
  }

  async client() {
    if (this._client) return this._client;
    let Anthropic;
    try {
      ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
    } catch {
      throw new Error(
        'The Anthropic provider needs the SDK: npm install @anthropic-ai/sdk'
      );
    }
    // Credentials resolve from the environment (ANTHROPIC_API_KEY, or an
    // `ant auth login` profile). Never read a key from the repo.
    this._client = new Anthropic();
    return this._client;
  }

  async complete({ system, messages }) {
    const client = await this.client();
    const response = await client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      output_config: { effort: this.effort },
      system,
      messages,
    });
    return response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
  }
}

/* Local models, so the benchmark can be run with no account at all. */
export class OllamaProvider {
  constructor(opts = {}) {
    this.model = opts.model || 'qwen2.5-coder:7b';
    this.host = opts.host || 'http://127.0.0.1:11434';
  }

  async complete({ system, messages }) {
    const res = await fetch(this.host + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        messages: [{ role: 'system', content: system }, ...messages],
      }),
    });
    if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
    const json = await res.json();
    return String(json?.message?.content || '').trim();
  }
}

export function createProvider(name, opts = {}) {
  if (name === 'mock') return new MockProvider(opts.script, opts.fallback);
  if (name === 'anthropic') return new AnthropicProvider(opts);
  if (name === 'ollama') return new OllamaProvider(opts);
  throw new Error(`Unknown provider "${name}". Use mock, anthropic or ollama.`);
}
