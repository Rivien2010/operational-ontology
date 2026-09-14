/** Presentation only: keep all demos readable without changing their runtime calls. */
import { inspect } from 'node:util'
import type { ObjectInstance, ObjectSet } from '../src/core.js'

// OO_DEMO_PACE=<ms> pauses before sections for terminal recordings.
const pace = Number(process.env.OO_DEMO_PACE ?? 0)
export const pause = () => { if (pace) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pace) }
export const heading = (title: string) => {
  pause()
  console.log(`\n━━ ${title} ${'━'.repeat(Math.max(0, 60 - title.length))}`)
}

// Show complete edits, properties and evidence, including nested objects and arrays.
export const log = (...values: unknown[]) => console.log(...values.map((value) =>
  typeof value === 'string' ? value : inspect(value, { depth: null, maxArrayLength: null, maxStringLength: null }),
))

/** Identify every member while keeping the exploration path readable. */
export function showObjects(label: string, value: ObjectInstance | ObjectSet) {
  const objects = 'objects' in value ? value.objects : [value]
  log(`    ${label}: ${value.type} (${objects.length})`, objects.map((object) => object.pk))
}

/** Display an operation's inputs and result; the demo makes the actual runtime call. */
export function trace(title: string, inputs: Record<string, ObjectInstance | ObjectSet>, result: ObjectSet) {
  pause()
  log(`\n  ${title}`)
  for (const [label, input] of Object.entries(inputs)) showObjects(label, input)
  showObjects('result', result)
}
