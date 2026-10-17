"""Readable public entry page; language selection remains progressive enhancement."""
from html import escape

ORIGIN = 'https://www.shmbox.com'
COPY = [
 ('zh', '简体中文', 'M-BOX 陆家嘴 · 上海现场音乐酒吧', '在上海陆家嘴听现场音乐、与朋友或同事相聚。官网提供菜单与价格、注明日期的演出信息、品牌档案及预约申请。白天至20:00前和晚间均可咨询包场，用于团建、沙龙或小型会议，具体安排由门店确认。', ['进入中文官网', '品牌与演出人物', '查看菜单', '预约座位']),
 ('en', 'English', 'M-BOX Lujiazui · Live music in Shanghai', 'Live music and gatherings with friends or colleagues in Lujiazui, Shanghai. Explore menus and prices, dated performance information, brand history and reservation requests. Daytime and evening private events are available by arrangement; confirm details with the venue.', ['Visit the website', 'Brand and performers', 'View menu', 'Request a reservation']),
 ('ru', 'Русский', 'M-BOX Луцзяцзуй · Живая музыка в Шанхае', 'Живая музыка и встречи с друзьями или коллегами в Луцзяцзуй. На сайте: меню и цены, программа с указанием даты, история бренда и заявки на бронирование. Дневные и вечерние закрытые мероприятия — по согласованию с заведением.', ['На сайт', 'История и исполнители', 'Меню', 'Заявка на бронирование']),
 ('ja', '日本語', 'M-BOX 陸家嘴 · 上海のライブミュージック', '上海・陸家嘴でライブ音楽を聴き、友人や同僚と過ごす夜に。メニューと価格、日付付きの公演情報、ブランドの記録、予約申請を掲載しています。昼間・夜間の貸切は店舗にご相談ください。', ['公式サイトへ', 'ブランドと出演者', 'メニュー', '予約を申し込む']),
 ('ko', '한국어', 'M-BOX 루자쭈이 · 상하이 라이브 음악', '상하이 루자쭈이에서 라이브 음악을 듣고 친구나 동료와 시간을 보내세요. 메뉴와 가격, 날짜가 명시된 공연 정보, 브랜드 기록과 예약 신청을 확인할 수 있습니다. 낮과 저녁 대관은 매장과 협의해 주세요.', ['공식 사이트', '브랜드와 공연자', '메뉴 보기', '예약 신청']),
 ('fr', 'Français', 'M-BOX Lujiazui · Musique live à Shanghai', 'De la musique live et des rencontres entre amis ou collègues à Lujiazui. Consultez la carte, les prix, le programme daté, les archives de la marque et les demandes de réservation. La privatisation en journée ou en soirée se confirme auprès du lieu.', ['Visiter le site', 'Archives et artistes', 'Voir la carte', 'Demander une réservation']),
 ('de', 'Deutsch', 'M-BOX Lujiazui · Livemusik in Shanghai', 'Livemusik und Treffen mit Freunden oder Kollegen in Lujiazui. Entdecken Sie Speisekarte und Preise, datierte Auftrittspläne, die Markengeschichte und Reservierungsanfragen. Private Veranstaltungen tagsüber und abends sind nach Absprache möglich.', ['Zur Website', 'Marke und Künstler', 'Speisekarte', 'Reservierung anfragen']),
]

def render_root():
    languages = ' '.join(f'<a href="/{lang}/" lang="{lang}">{name}</a>' for lang, name, *_ in COPY)
    cards = []
    for lang, name, title, description, labels in COPY:
        links = ' '.join(f'<a href="/{lang}/{suffix}">{escape(label)}</a>' for suffix, label in zip(['', 'archive/', 'menu/', 'reserve/'], labels))
        cards.append(f'<section lang="{lang}"><h2>{escape(title)}</h2><p>{escape(description)}</p><nav aria-label="{escape(name)}">{links}</nav></section>')
    alternates = ''.join(f'<link rel="alternate" hreflang="{lang}" href="{ORIGIN}/{lang}/">' for lang, *_ in COPY)
    return f'''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>M-BOX 上海陆家嘴｜Live Music in Shanghai</title>
<meta name="description" content="M-BOX上海陆家嘴现场音乐酒吧。查看七语官网、菜单价格、演出信息、品牌档案与预约。Live music, menus, performances and reservations in Lujiazui, Shanghai.">
<meta name="robots" content="index,follow,max-image-preview:large"><link rel="canonical" href="{ORIGIN}/">{alternates}<link rel="alternate" hreflang="x-default" href="{ORIGIN}/">
<style>html{{color-scheme:dark}}body{{margin:0;background:#10231b;color:#f0eadc;font:17px/1.7 system-ui,sans-serif}}main{{max-width:1000px;margin:auto;padding:40px 24px}}a{{color:#e2c98e;text-underline-offset:5px}}nav{{display:flex;flex-wrap:wrap;gap:12px 24px}}h1{{font-size:clamp(30px,6vw,58px);line-height:1.15}}h2{{font-size:23px}}section{{border-top:1px solid #64715a;padding:24px 0}}address{{font-style:normal}}footer{{margin-top:32px}}a:focus-visible{{outline:2px solid #e2c98e;outline-offset:5px}}</style>
<script src="/language.js" defer></script></head><body><main>
<header><p>M—BOX · SHANGHAI · LIVE MUSIC</p><h1>上海的夜晚，仍在演唱。</h1><p lang="en">Live music in Lujiazui, Shanghai.</p><nav aria-label="选择语言 / Select language">{languages}</nav></header>
<address><p>上海市浦东新区浦东南路889号，陆家嘴中心穹顶花园 RG05</p><p lang="en">RG05, rooftop garden, L+Mall, 889 Pudong South Road, Pudong, Shanghai.</p><p><a href="tel:+8617621392152">+86 176 2139 2152</a> · <a href="mailto:shmbox@qq.com">shmbox@qq.com</a></p></address>
{''.join(cards)}
<footer><p>演出和包场安排以门店确认为准；提交预约申请不代表座位已确认。</p><p lang="en">Confirm performance and event arrangements with the venue. A reservation request is subject to staff confirmation.</p><a href="https://beian.miit.gov.cn/#/Integrated/recordQuery" rel="noopener">沪ICP备2023018086号-3</a></footer>
</main></body></html>'''

if __name__ == '__main__':
    from pathlib import Path
    base = Path(__file__).parent
    for target in [base/'public/index.html', base/'aliyun/public-overrides/index.html']:
        target.write_text(render_root(), encoding='utf-8')
