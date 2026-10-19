import { afterEach, describe, expect, it, vi } from 'vitest'
import { sharedQQTransport, QQ_TRANSPORT_KEY } from '../src/shared-transport.js'
afterEach(()=>{delete (globalThis as unknown as Record<symbol,unknown>)[QQ_TRANSPORT_KEY]})
describe('shared private/group QQ transport',()=>{
  it('owns one connection and delivers an event once to each consumer',()=>{
    const hub=sharedQQTransport(),call=vi.fn(),provider={connected:true,call},group=vi.fn();const detach=hub.attach(provider),off=hub.subscribe(group)
    hub.dispatch(provider,{message_type:'group',group_id:100000003});expect(group).toHaveBeenCalledTimes(1);expect(hub.snapshot()).toEqual({connected:true,connectionCount:1,subscribers:1})
    expect(()=>hub.attach({connected:true,call})).toThrow('already mounted');off();detach();expect(hub.snapshot().connectionCount).toBe(0)
  })
  it('preserves uncertain-send failure and never retries it',async()=>{
    const hub=sharedQQTransport(),call=vi.fn(async()=>{throw Error('uncertain')});hub.attach({connected:true,call})
    await expect(hub.call('send_group_msg',{group_id:100000003})).rejects.toThrow('uncertain');expect(call).toHaveBeenCalledTimes(1)
  })
  it('reconnects existing group subscribers without duplicating them',async()=>{
    const hub=sharedQQTransport(),status=vi.fn(),first={connected:true,call:vi.fn()},second={connected:false,call:vi.fn()}
    hub.subscribe(()=>{},status);const stop=hub.attach(first);stop();const detach=hub.attach(second)
    const ready=hub.whenConnected();second.connected=true;hub.notify(second,true);await ready
    expect(hub.snapshot().subscribers).toBe(1);expect(status).toHaveBeenLastCalledWith(true);detach()
  })
  it('isolates a broken group subscriber from other consumers',()=>{
    const hub=sharedQQTransport(),provider={connected:true,call:vi.fn()},other=vi.fn(),warn=vi.spyOn(console,'warn').mockImplementation(()=>{})
    try{hub.attach(provider);hub.subscribe(()=>{throw Error('group disk error')});hub.subscribe(other);expect(()=>hub.dispatch(provider,{message_type:'private'})).not.toThrow();expect(other).toHaveBeenCalledTimes(1)}finally{warn.mockRestore()}
  })
})
