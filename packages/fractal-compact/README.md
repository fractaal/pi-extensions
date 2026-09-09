# @fractaal/pi-fractal-compact

Canonical package for Ben/Fractal's high-fidelity compaction hook.

It replaces stock compaction with a methodology-preserving summary prompt and
also emits ALR-compatible compaction status events when an event bus is present.

When Pi supplies `session_before_compact.summarizeNativeContext`, the extension
uses that checkpoint-aware callback with its existing Fractal prompt instead of
making a tail-only provider request. Pi owns checkpoint replay, cancellation,
and the successful plaintext checkpoint transition. Ordinary compaction keeps
using the registered provider when no native callback is supplied.
