import type {GuestSharedCart} from './guest-api'
export type CartReadToken={scope:number;revision:number}
/** Each session has a monotone server snapshot; reads started before a write expire. */
export class GuestCartState {
  scope=0
  private revision=0
  private cart:GuestSharedCart|null=null
  reset(){this.scope++;this.revision++;this.cart=null}
  readToken():CartReadToken{return{scope:this.scope,revision:this.revision}}
  beginWrite(){this.revision++;return this.scope}
  isCurrent(scope:number){return scope===this.scope}
  isCurrentRead(token:CartReadToken){return this.isCurrent(token.scope)&&token.revision===this.revision}
  accept(cart:GuestSharedCart,scope:number,read?:CartReadToken){
    if(!this.isCurrent(scope)||(read&&!this.isCurrentRead(read)))return false
    if(this.cart&&(cart.generation<this.cart.generation||(cart.generation===this.cart.generation&&cart.version<this.cart.version)))return false
    this.cart=cart;return true
  }
}
