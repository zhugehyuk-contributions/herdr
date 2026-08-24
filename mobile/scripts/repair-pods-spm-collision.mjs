// Repairs the `Pods.xcodeproj` that `pod install` produces when HerdrSsh.podspec declares
// `spm_dependency`. See .prd/12-qr-pairing.md for the measurements behind every claim here.
//
// CocoaPods' SPM integration runs AFTER `post_install` and allocates ids for its four SPM objects
// (two XCRemoteSwiftPackageReference, two XCSwiftPackageProductDependency) from a counter that
// starts at zero — in the very id space the Pods project uses for its own project object, main
// group and products group. Past a certain pod count (installing expo-camera is enough) those four
// ids land on 46EB2E00000000/0010/0020/0030 and EVICT the objects that own them. Xcode then reads
// `rootObject`, finds an XCRemoteSwiftPackageReference, calls `_setSavedArchiveVersion:` on it and
// reports "The project 'Pods' is damaged"; no pod target builds and every modulemap goes missing.
// Without expo-camera the same install lands them at 46EB2E0003CF30+ and the project opens — the
// collision is positional, not a property of the packages.
//
// The repair, run after `pod install` and idempotent:
//   1. move every SPM object to a free id, rewriting its referrers, then
//   2. restore the objects it evicted from a snapshot of an install WITHOUT spm_dependency,
//      and give the project object its packageReferences back.
//
// CocoaPods' own wiring is kept rather than hand-written: an earlier attempt that wrote the SPM
// objects directly produced a project that opens but in which `import Citadel` still does not
// resolve, so the wiring CocoaPods emits is load-bearing in ways the pbxproj alone does not show.
//
// pbxproj "sections" are comments around one flat `objects` dictionary, so restored blocks are
// reinserted in a single place rather than each into its original section.
import { readFileSync, writeFileSync } from 'node:fs'

/** Returns the full `\t\t<id> ... = {\n...\n\t\t};` block for an id, or null. */
function objectBlock(source, id) {
  const start = source.search(new RegExp(`^\\t\\t${id} .*= \\{$`, 'm'))
  if (start === -1) {
    return null
  }
  const end = source.indexOf('\n\t\t};', start)
  if (end === -1) {
    return null
  }
  return source.slice(start, end + '\n\t\t};'.length)
}

/**
 * Returns the repaired project text, or null when there is nothing to repair. Pure so the collision
 * can be exercised on a fixture rather than on a 66k-line generated file.
 */
export function repairPodsSpmCollision(projectText, cleanText) {
  let text = projectText
  if (text.includes('isa = PBXProject;')) {
    return null
  }

  // 1. Move every SPM object out of the low id range, rewriting referrers. Each id always appears
  //    beside its own comment, so a comment-anchored rewrite cannot touch an unrelated object.
  const spm = [
    ...text.matchAll(/^\t\t([0-9A-F]+) (\/\* XCRemoteSwiftPackageReference "[^"]+" \*\/) = \{/gm),
    ...text.matchAll(
      /^\t\t([0-9A-F]+) (\/\* [^*]+ \*\/) = \{\n\t\t\tisa = XCSwiftPackageProductDependency;/gm
    )
  ]
  if (spm.length === 0) {
    throw new Error('PBXProject is missing but no SPM objects were found — unknown damage')
  }

  const evicted = []
  const packageReferences = []
  let nextFree = 0xffff00
  for (const [, id, comment] of spm) {
    let free
    do {
      free = `46EB2E00${nextFree.toString(16).toUpperCase().padStart(6, '0')}`
      nextFree += 0x10
    } while (text.includes(free))
    text = text.replaceAll(`${id} ${comment}`, `${free} ${comment}`)
    evicted.push(id)
    if (comment.includes('XCRemoteSwiftPackageReference')) {
      packageReferences.push(`\t\t\t\t${free} ${comment},`)
    }
  }

  // 2. Restore what they displaced.
  const restored = []
  for (const id of evicted) {
    if (objectBlock(text, id)) {
      continue
    }
    const block = objectBlock(cleanText, id)
    if (!block) {
      throw new Error(`id ${id} was evicted but the clean snapshot has no object for it`)
    }
    restored.push(
      block.includes('isa = PBXProject;')
        ? block.replace(
            /\n(\t\t\tproductRefGroup = )/,
            `\n\t\t\tpackageReferences = (\n${packageReferences.join('\n')}\n\t\t\t);\n$1`
          )
        : block
    )
  }

  const marker = '/* Begin PBXResourcesBuildPhase section */'
  if (!text.includes(marker)) {
    throw new Error('cannot find an anchor to reinsert the restored objects')
  }
  return {
    text: text.replace(
      marker,
      `/* Begin restored-by-repair-pods-spm-collision section */\n${restored.join('\n')}\n/* End restored-by-repair-pods-spm-collision section */\n\n${marker}`
    ),
    evicted
  }
}

if (process.argv[1]?.endsWith('repair-pods-spm-collision.mjs')) {
  const projectPath = process.argv[2] ?? 'ios/Pods/Pods.xcodeproj/project.pbxproj'
  const snapshotPath = process.argv[3]
  if (!snapshotPath) {
    throw new Error(
      'usage: repair-pods-spm-collision.mjs <project.pbxproj> <clean-project.pbxproj>'
    )
  }
  const result = repairPodsSpmCollision(
    readFileSync(projectPath, 'utf8'),
    readFileSync(snapshotPath, 'utf8')
  )
  if (result === null) {
    console.log('[repair-pods-spm] PBXProject intact — nothing to repair')
  } else {
    writeFileSync(projectPath, result.text)
    console.log(`[repair-pods-spm] moved SPM objects, restored: ${result.evicted.join(' ')}`)
  }
}
