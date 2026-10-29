// files bundled as text by the wrangler.toml [[rules]]
declare module '*/bin/share' {
  const text: string
  export default text
}
declare module '*.md' {
  const text: string
  export default text
}
