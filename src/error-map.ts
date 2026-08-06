import { MatrixApiError } from "./http.js";
import {
  AuthenticationError,
  ConfigurationError,
  CryptoNotReadyError,
  EncryptedRoomWithoutCryptoError,
  HandlerTimeoutError,
  InsufficientPowerError,
  MediaTooLargeError,
  MiniAppAuthError,
  PeerKeysMissingError,
  RateLimitedError,
  WaitForTimeoutError,
  aiomatrixError,
} from "./errors.js";

/**
 * Map library / homeserver errors to a short user-facing notice.
 * Never includes tokens, stack traces, or raw API JSON.
 */
export function mapBotError(error: unknown): {
  text: string;
  code: string;
  retryable: boolean;
} {
  if (error instanceof InsufficientPowerError) {
    return {
      text: "I don't have enough power in this room for that action.",
      code: "insufficient_power",
      retryable: false,
    };
  }
  if (error instanceof WaitForTimeoutError) {
    return {
      text: "Timed out waiting for your reply.",
      code: "wait_for_timeout",
      retryable: true,
    };
  }
  if (error instanceof HandlerTimeoutError) {
    return {
      text: "That took too long — please try again.",
      code: "handler_timeout",
      retryable: true,
    };
  }
  if (error instanceof RateLimitedError) {
    return {
      text: "The homeserver asked me to slow down. Try again in a moment.",
      code: "rate_limited",
      retryable: true,
    };
  }
  if (error instanceof AuthenticationError) {
    return {
      text: "My session expired. An admin needs to re-login the bot.",
      code: "auth",
      retryable: false,
    };
  }
  if (error instanceof EncryptedRoomWithoutCryptoError || error instanceof CryptoNotReadyError) {
    return {
      text: "Encryption isn't ready for this room yet.",
      code: "crypto",
      retryable: true,
    };
  }
  if (error instanceof PeerKeysMissingError) {
    return {
      text: "I can't encrypt to everyone in this room yet (missing device keys).",
      code: "peer_keys",
      retryable: true,
    };
  }
  if (error instanceof MediaTooLargeError) {
    return {
      text: "That file is too large to send.",
      code: "media_too_large",
      retryable: false,
    };
  }
  if (error instanceof MiniAppAuthError) {
    return {
      text: "MiniApp session is invalid or expired.",
      code: "miniapp_auth",
      retryable: false,
    };
  }
  if (error instanceof ConfigurationError) {
    return {
      text: "Bot configuration error — please contact an admin.",
      code: "config",
      retryable: false,
    };
  }
  if (error instanceof MatrixApiError) {
    if (error.errcode === "M_FORBIDDEN") {
      return {
        text: "I'm not allowed to do that here.",
        code: "forbidden",
        retryable: false,
      };
    }
    if (error.errcode === "M_NOT_FOUND") {
      return {
        text: "I couldn't find that resource.",
        code: "not_found",
        retryable: false,
      };
    }
    if (error.status === 429 || error.errcode === "M_LIMIT_EXCEEDED") {
      return {
        text: "Rate limited by the homeserver. Please retry shortly.",
        code: "rate_limited",
        retryable: true,
      };
    }
    return {
      text: "The homeserver rejected that request.",
      code: error.errcode ?? "matrix_api",
      retryable: error.status >= 500,
    };
  }
  if (error instanceof aiomatrixError) {
    return {
      text: "Something went wrong handling that.",
      code: error.name,
      retryable: false,
    };
  }
  return {
    text: "Something went wrong handling that. Please try again.",
    code: "unknown",
    retryable: false,
  };
}
