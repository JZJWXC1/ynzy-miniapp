const FAQ_REPLIES = {
  report: '第一版报备保持简单：客户称呼可选，客户联系方式必填。签单必须从报备记录发起。',
  deal: '签单从报备记录发起，只填写成交月租、房东实际支付佣金和可选备注；管理员确认后才生成正式分佣，上传人分佣由后端按房东实付佣金的20%计算。',
  map: '地图找房只展示真实且经过确认的小区坐标；无可靠坐标的房源可进普通列表，但不会进入地图，也不会展示具体门牌或敏感联系方式。',
  maintenance: '房态规则固定为第3天提醒、第5天再次提醒、第7天未更新自动失效；前台只展示有效房源，失效房源保留在后台资产池。',
  hidden: '房源群、积分、充值、换群和微信支付第一版先隐藏，历史后端代码保留，当前找房流程不依赖这些入口。',
  general: '我可以帮中介按预算、区域或小区、户型/租法和标签偏好找真实可租房源，也可以说明报备、签单、地图和房态规则。'
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
