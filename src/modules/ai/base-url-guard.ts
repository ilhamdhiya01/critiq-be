import {
  assertSafeOutboundUrl,
  isPrivateAddress,
  UnsafeUrlError,
} from '../../common/net/safe-url';
import { AiError } from './ai-error';

export { isPrivateAddress };

// The openai_compatible base URL check (src/common/net/safe-url.ts), in the
// AI module's own error contract: insecure_base_url.
export async function assertSafeBaseUrl(
  ...args: Parameters<typeof assertSafeOutboundUrl>
): Promise<URL> {
  try {
    return await assertSafeOutboundUrl(...args);
  } catch (error) {
    if (error instanceof UnsafeUrlError) {
      throw new AiError('insecure_base_url', {
        providerMessage: `Base ${error.message}`,
      });
    }
    throw error;
  }
}
