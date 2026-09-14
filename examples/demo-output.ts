/** Presentation only: keep all demos readable without changing their runtime calls. */
import { inspect } from 'node:util'

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
