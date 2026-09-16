import {isIP} from 'node:net'
/** The caller must supply Fastify request.ip after trusted-proxy validation.
 * Never substitutes a server IP or accepts an address from a payment body. */
export function normalizePaymentClientIp(value:string):string{
 const normalized=value.trim().replace(/^::ffff:/i,'')
 if(isIP(normalized)===0)throw new TypeError('Invalid payment client IP')
 return normalized
}
