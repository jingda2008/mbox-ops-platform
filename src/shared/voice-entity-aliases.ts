const englishNameReadings: Readonly<Record<string, readonly string[]>> = {
  tom: ['汤姆', '托姆'],
  jerry: ['杰瑞', '杰里', '吉瑞'],
  tyke: ['泰克', '太克', '泰科'],
}

export function englishReadingAliases(name: string) {
  const aliases: string[] = []
  for (const [englishName, readings] of Object.entries(englishNameReadings)) {
    const pattern = new RegExp(`\\b${englishName}\\b`, 'gi')
    if (!pattern.test(name)) continue
    for (const reading of readings) aliases.push(name.replace(pattern, reading))
  }
  return aliases
}
