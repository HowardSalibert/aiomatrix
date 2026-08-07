# Optional OpenTelemetry adapters

Prefer:

```ts
import { createOtelMetricHandler, createOtelRequestHandler } from "aiomatrix/otel";
```

No `@opentelemetry/*` dependency — wire your SDK via callbacks.
