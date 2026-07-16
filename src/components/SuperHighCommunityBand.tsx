import type { CommunityBrandPresentation } from '../shared/contracts'

interface SuperHighCommunityBandProps {
  brand: CommunityBrandPresentation
  compact?: boolean
}

export function SuperHighCommunityBand({ brand, compact = false }: SuperHighCommunityBandProps) {
  return (
    <section className={`superhigh-community-band${compact ? ' is-compact' : ''}`} aria-label={brand.name}>
      <div className="superhigh-color-rail" aria-hidden="true"><i /><i /><i /><i /><i /></div>
      <img src={brand.markUrl} alt={`${brand.name}品牌标识`} />
      <div className="superhigh-community-copy">
        <small>{brand.eyebrow}</small>
        <strong>{brand.name}</strong>
        <p>{brand.tagline}</p>
        {!compact && <div className="superhigh-community-highlights">{brand.highlights.map((item) => <span key={item}>{item}</span>)}</div>}
      </div>
    </section>
  )
}
