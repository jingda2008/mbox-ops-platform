export interface MenuImageOption {
  label: string
  url: string
}

const groups = [
  {
    prefix: 'snack',
    label: '小食',
    names: ['爽脆黄瓜仔', '柿种生仁', '炸洋葱圈', '川麻鸡块', '炸薯条', '鸡米花', '墨西哥玉米片', '奥尔良香烤鸡翅', '酥炸鱿鱼拼盘', '橄榄酸黄瓜小碟', '台式碳烤香肠', '香辣手抓骨', '蔓越莓坚果芝士盘', '水果拼盘', '伊利比亚火腿拼盘', '小蛋糕'],
  },
  {
    prefix: 'signature',
    label: '情绪特调',
    names: ['真我', '喜', '乐', '哀', '怒', '悠然', '安愉', '清欢', '逢喜', '坎坷', '彷徨', '期许', '妒忌', '愤恨', '莓你不行', '都市绿洲'],
  },
  {
    prefix: 'classic',
    label: '经典鸡尾酒',
    names: ['金汤力', '莫吉托', '茉莉', '新加坡司令', '龙舌兰日出', '威士忌酸', '椰林飘香', '僵尸', '大吉利', '长岛冰茶', '尼格罗尼', 'Highball'],
  },
  {
    prefix: 'package',
    label: '情绪套餐',
    names: ['我好累', '要期待', '醉眼前', '好心动', '烦死了', '想发疯', '吐槽中', '走一个', '须尽欢', '爽翻了', '够尽兴', '一起疯'],
  },
] as const

export const menuImageOptions: readonly MenuImageOption[] = groups.flatMap((group) => (
  group.names.map((name, index) => ({
    label: `${group.label} · ${name}`,
    url: `/menu/2026-08/items/${group.prefix}-${String(index + 1).padStart(2, '0')}.jpg`,
  }))
))
