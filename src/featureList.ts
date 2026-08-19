// The registration point for optional GUI features: import each feature module
// here and call registerFeature (see docs/adr/0008-optional-feature-registry.md).
// main.ts imports this module for its side effects, so a new optional feature
// costs one line here rather than another edit inside main.ts.
//
// Nothing is registered yet — Settings → Features shows its empty state until
// the first feature lands.
export {};
