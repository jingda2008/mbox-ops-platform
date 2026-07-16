import type { CommunityBrandPresentation } from '../shared/contracts'

interface SuperHighCommunityBandProps {
  brand: CommunityBrandPresentation
  compact?: boolean
}

export function SuperHighCommunityBand({ brand, compact = false }: SuperHighCommunityBandProps) {
  return (
    <section className={`superhigh-brand-signature${compact ? ' is-compact' : ''}`} aria-label={`${brand.name}母品牌标识`}>
      <img src={brand.markUrl} alt={`${brand.name}品牌标识`} />
      <div className="superhigh-signature-copy">
        <small>{brand.eyebrow}</small>
        <p>{brand.tagline}</p>
        {!compact && <span>{brand.highlights.join(' · ')}</span>}
      </div>
      <div className="superhigh-signature-colors" aria-hidden="true"><i /><i /><i /><i /></div>
    </section>
  )
}
