// @butinapp/sdk/testing — the seeded synthetic-sample toolkit a plugin reaches for when authoring a
// capability's `sample`. `createSampleGen` builds a deterministic generator (a shared cast of fake people +
// synthetic primitives — emails are always `@example.invalid`, so a generated raw can NEVER carry real PII);
// `resolveSampleConfig` turns the size knobs into a concrete `SampleConfig`. Kept off `/util` (which is the
// runtime edge-normalizer surface) because this is demo/seed tooling, not request-path code.

export { createSampleGen, resolveSampleConfig } from './synthetic.js'
export type {
  SamplePerson,
  SampleConfig,
  SampleSize,
  SampleDay,
  SampleMonth,
  SampleGen,
  SampleGenerator
} from './synthetic.js'
