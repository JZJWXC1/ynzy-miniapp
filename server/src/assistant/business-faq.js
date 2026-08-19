const FAQ_REPLIES = {
  report: '客户报备与从报备发起签单当前已暂停，小程序没有新增入口；旧客户端调用也会被服务器拒绝。历史报备、签单和分佣记录继续由后台只读保留，暂停期间请按团队当前线下流程处理。',
  deal: '新签单当前已暂停，页面和服务器都不会新增或确认记录。历史分佣只读保留；详情佣金比例由服务器计算，中介不能提交身份、维护人、比例或金额来改变结果。未来是否恢复以管理员通知为准。',
  map: '地图找房按已确认坐标、近似位置、板块中心兜底分级标注，只展示小区级位置；不会展示具体门牌、房号或敏感联系方式。',
  maintenance: '房态规则固定为第3天提醒、第5天再次提醒、第7天未更新自动失效；前台只展示有效房源，失效房源保留在后台资产池。',
  hidden: '房源群、积分、充值、换群和微信支付第一版先隐藏，历史后端代码保留，当前找房流程不依赖这些入口。',
  general: '我可以帮中介按预算、区域或小区、户型/租法和标签偏好找真实可租房源，也可以说明报备与签单暂停状态、服务端佣金、地图和房态规则。'
}

function buildBusinessFaq(topic) {
  const normalizedTopic = FAQ_REPLIES[topic] ? topic : 'general'
  return {
    reply: FAQ_REPLIES[normalizedTopic],
    nextQuestion: '',
    topic: normalizedTopic
  }
}

module.exports = {
  buildBusinessFaq
}
