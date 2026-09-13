import {afterEach,describe,expect,it,vi} from 'vitest'
import {startTableOrderRefresh} from './table-order-refresh'
afterEach(()=>vi.useRealTimers())
const fixture=(load: (signal:AbortSignal)=>Promise<string>)=>{
  const options={load:vi.fn(load),visible:()=>true,retryable:(e:unknown)=>e!=='denied',onStart:vi.fn(),onSuccess:vi.fn(),onError:vi.fn(),onSettled:vi.fn()}
  const control=startTableOrderRefresh(options)
  return {options,control}
}
describe('table refresh recovery',()=>{
  it('recovers after a transient failure and caps repeated failure until online/visible resume',async()=>{
    vi.useFakeTimers()
    const {control,options}=fixture(async()=>{throw new Error('offline')})
    await vi.advanceTimersByTimeAsync(120000)
    expect(options.load).toHaveBeenCalledTimes(3)
    options.load.mockResolvedValue('new table data')
    control.resume();await vi.advanceTimersByTimeAsync(0)
    expect(options.onSuccess).toHaveBeenCalledWith('new table data')
    await vi.advanceTimersByTimeAsync(10000)
    expect(options.load).toHaveBeenCalledTimes(5)
    control.dispose()
  })
  it('does not retry permission failures on a visibility event',async()=>{
    vi.useFakeTimers()
    const {control,options}=fixture(async()=>{throw 'denied'})
    await vi.advanceTimersByTimeAsync(0);control.resume()
    await vi.advanceTimersByTimeAsync(120000)
    expect(options.load).toHaveBeenCalledOnce()
    control.retry();await vi.advanceTimersByTimeAsync(0)
    expect(options.load).toHaveBeenCalledTimes(2);control.dispose()
  })
  it('ignores a late response after table disposal even if the loader ignores abort',async()=>{
    vi.useFakeTimers();let resolve!:(value:string)=>void
    const {control,options}=fixture(()=>new Promise(r=>{resolve=r}))
    control.resume();control.retry()
    expect(options.load).toHaveBeenCalledOnce()
    control.dispose();resolve('old table');await vi.advanceTimersByTimeAsync(0)
    expect(options.onSuccess).not.toHaveBeenCalled()
    expect(options.load.mock.calls[0][0].aborted).toBe(true)
  })
})
