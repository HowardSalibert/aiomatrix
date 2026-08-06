/**
 * Example MiniApp sendData humanizer — plug into buildMiniAppDataContent({ formatBody })
 * or reuse formatMiniAppDataPreview for the default path.
 */
import { formatMiniAppDataPreview, parseMiniAppPayload } from "../dist/index.js";

/** Russian labels for a campus / events bot. */
export function campusHumanizer(data, parsed) {
  const payload = parseMiniAppPayload(parsed ?? data);
  if (!payload) return formatMiniAppDataPreview(data);
  switch (payload.action) {
    case "rsvp":
      return `Ответ на событие: ${payload.status ?? "?"}`;
    case "submit":
      return "Форма отправлена";
    case "publish":
      return `Публикация: ${payload.title ?? "без названия"}`;
    default:
      return formatMiniAppDataPreview(data);
  }
}
