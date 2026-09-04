function readAlipayPhoneAuthorization() {
  return {
    code: '',
    message: '支付宝手机号授权需要后端验签解密，当前尚未接通；不影响浏览、预约和点单。',
  }
}

export { readAlipayPhoneAuthorization }
