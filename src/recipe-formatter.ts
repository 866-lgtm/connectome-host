import { AnthropicXmlFormatter, NativeFormatter, OpenAIResponsesFormatter } from '@animalabs/membrane';
import type { Recipe } from './recipe.js';

/**
 * The membrane formatter a recipe's agent runs through.
 *
 * `anthropic-xml` is pinned to XML tool mode. Since membrane 0.5.87 a formatter
 * constructed without a mode leaves the choice to membrane, which picks native
 * whenever the formatter supports it, and AnthropicXmlFormatter does. That
 * turned a prefill-transcript agent ("participant: text" runs, an assistant
 * prefill, speaker stop sequences, XML tools) into an ordinary native chat with
 * native tools. The recipe's `anthropic-xml` promises the prefill-era
 * structure, so the mode is stated here rather than derived.
 */
export function recipeFormatter(
  formatter: Recipe['agent']['formatter'],
  provider: string,
): AnthropicXmlFormatter | NativeFormatter | OpenAIResponsesFormatter {
  if (provider === 'openai-responses' || provider === 'openai-codex') return new OpenAIResponsesFormatter();
  if (formatter === 'anthropic-xml') return new AnthropicXmlFormatter({ toolMode: 'xml' });
  return new NativeFormatter();
}
