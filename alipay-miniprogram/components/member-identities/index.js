const { getMemberCards } = require('../../utils/api')
const { dateInput } = require('../../utils/format')

function activeIdentities(cards, now) {
  return Array.from(new Map((cards || []).filter(card => {
    const from = new Date(dateInput(card.valid_from)).getTime()
    const until = new Date(dateInput(card.valid_until)).getTime()
    return card.status === 'active' && card.expired === false && from <= now && until > now && String(card.name || '').trim()
  }).map(card => [card.project_id || card.id, { id: card.id, name: card.name }])).values())
}

Component({
  data: { identities: [], loading: true, failed: false },
  didMount() { this.reload() },
  didUnmount() { this.sequence = (this.sequence || 0) + 1; this.inFlight = false },
  methods: {
    async reload() {
      if (this.inFlight) return
      const sequence = this.sequence = (this.sequence || 0) + 1
      this.inFlight = true
      this.setData({ identities: [], loading: true, failed: false })
      try {
        const cards = [], seen = new Set()
        let cursor = null
        do {
          const result = await getMemberCards(cursor ? { cards: cursor } : undefined)
          if (sequence !== this.sequence) return
          if (!result.activeMember) { cards.length = 0; break }
          cards.push(...(result.cards || []))
          cursor = result.nextCursors && result.nextCursors.cards
          if (cursor && (seen.has(cursor) || seen.size >= 20)) throw new Error('卡片分页未完成')
          if (cursor) seen.add(cursor)
        } while (cursor)
        this.setData({ identities: activeIdentities(cards, Date.now()), loading: false })
      } catch (_) {
        if (sequence === this.sequence) this.setData({ identities: [], loading: false, failed: true })
      } finally { if (sequence === this.sequence) this.inFlight = false }
    },
  },
})
