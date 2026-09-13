/** One table, one in-flight read. Failures retain data; only transient failures retry. */
export function startTableOrderRefresh<T>(options: {
  load(signal: AbortSignal): Promise<T>
  visible(): boolean
  retryable(error: unknown): boolean
  onStart(): void
  onSuccess(value: T): void
  onError(error: unknown): void
  onSettled(): void
}) {
  let disposed=false, active=false, failures=0, denied=false
  let timer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | undefined
  const clear=()=>{ if(timer!==undefined) clearTimeout(timer);timer=undefined }
  const run=async()=>{
    if(disposed||active||denied||!options.visible()) return
    clear();active=true;controller=new AbortController();options.onStart()
    try {
      const value=await options.load(controller.signal)
      if(disposed||controller.signal.aborted)return
      failures=0;options.onSuccess(value)
    } catch(error) {
      if(disposed||controller.signal.aborted)return
      failures++;denied=!options.retryable(error);options.onError(error)
    } finally {
      active=false
      if(!disposed){
        options.onSettled()
        if(!denied&&failures<3) timer=setTimeout(()=>{void run()},failures ? Math.min(60000,10000*2**failures):10000)
      }
    }
  }
  void run()
  return {
    resume(){if(!denied&&!active){failures=0;void run()}},
    retry(){if(!active){denied=false;failures=0;void run()}},
    dispose(){disposed=true;clear();controller?.abort()},
  }
}
