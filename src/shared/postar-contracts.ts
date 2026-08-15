import type {
  ProviderPaymentQueryRequest,
  ProviderRefundQueryRequest,
  ProviderRefundRequest,
} from './payment-provider-contracts.js'

export type PostarEnvironment = 'test' | 'uat' | 'production'

export const POSTAR_BASE_URLS: Readonly<Record<PostarEnvironment, string>> = {
  production: 'https://yyfsvxm.postar.cn',
  test: 'https://xyf-server-test.postar.cn',
  uat: 'https://xyzscxm.postar.cn',
}

export const POSTAR_ENDPOINTS = {
  closeTerminalOrder: '/yyfsevr/order/closeCashierPay',
  createJsapiPayment: '/yyfsevr/order/pay',
  createQrPayment: '/yyfsevr/order/getCodeUrl',
  createBarcodePayment: '/yyfsevr/order/scanByMerchant',
  queryPayment: '/yyfsevr/order/orderQuery',
  queryRefund: '/yyfsevr/order/refundQuery',
  refund: '/yyfsevr/order/refund',
} as const

export type PostarRefundTag = '1' | '2' | '9' | '11' | '12' | '30'

export interface PostarHttpRequest {
  url: string
  headers: Readonly<Record<string, string>>
  body: Uint8Array
}

export interface PostarHttpResponse {
  status: number
  headers: Readonly<Record<string, string | readonly string[] | undefined>>
  body: Uint8Array
}

export interface PostarHttpClient {
  post(request: PostarHttpRequest): Promise<PostarHttpResponse>
}

export interface PostarPaymentMetadata {
  /** The Postar order creation date, formatted yyyyMMdd. */
  orderDate: string
}

export interface PostarRefundMetadata {
  /** Merchant number omitted by the current provider refund request contract. */
  merchantId: string
  /** The original payment channel required by Postar's ordinary refund endpoint. */
  tag: PostarRefundTag
}

export interface PostarRefundQueryMetadata {
  /** The Postar refund order creation date, formatted yyyyMMdd. */
  refundDate: string
}

export interface PostarTransactionMetadataSource {
  getPaymentMetadata(request: ProviderPaymentQueryRequest): Promise<PostarPaymentMetadata>
  getRefundMetadata(request: ProviderRefundRequest): Promise<PostarRefundMetadata>
  getRefundQueryMetadata(request: ProviderRefundQueryRequest): Promise<PostarRefundQueryMetadata>
}

export interface PostarBillDownloadRequest {
  agencyId: string
  merchantId: string
  businessDate: string
  format: 'english-json-lines'
}

export interface PostarSftpBillSource {
  downloadBill(request: PostarBillDownloadRequest): Promise<Uint8Array>
}

export interface PostarAdapterOptions {
  environment: PostarEnvironment
  httpClient: PostarHttpClient
  metadataSource: PostarTransactionMetadataSource
  billSource: PostarSftpBillSource
  now?: () => Date
  agencyIdSecretName?: string
  publicKeySecretName?: string
}

export type PostarJsonPrimitive = string | number | boolean | null
export type PostarJsonValue =
  | PostarJsonPrimitive
  | readonly PostarJsonValue[]
  | { readonly [key: string]: PostarJsonValue }

export type PostarTopLevelPayload = Readonly<Record<string, PostarJsonValue | undefined>>

export interface PostarSynchronousResponse {
  code: string
  msg: string
  data?: PostarJsonValue
  /** Not present in the official synchronous schemas; verified when supplied. */
  sign?: string
}

export interface PostarCallbackAcknowledgementCandidate {
  rspCod: '' | '000000'
  rspMsg: 'success'
}

export const POSTAR_CALLBACK_ACKNOWLEDGEMENT_CANDIDATES: readonly PostarCallbackAcknowledgementCandidate[] = [
  { rspCod: '', rspMsg: 'success' },
  { rspCod: '000000', rspMsg: 'success' },
]
