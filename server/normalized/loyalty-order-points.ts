/** Difference of per-order floors, including partial refunds and recollection.
 * Never round a refund in isolation or carry a remainder to another order. */
export function orderPointsDelta(beforeMinor:number,afterMinor:number,numerator:bigint=1n,denominator:bigint=1000n):number {
  if (![beforeMinor,afterMinor].every(n=>Number.isSafeInteger(n)&&n>=0)||numerator<0n||denominator<=0n) throw new RangeError('Invalid order points basis')
  const delta=Number(BigInt(afterMinor)*numerator/denominator-BigInt(beforeMinor)*numerator/denominator)
  if(!Number.isSafeInteger(delta)||Math.abs(delta)>2_000_000_000)throw new RangeError('Order points outside supported range')
  return delta
}
