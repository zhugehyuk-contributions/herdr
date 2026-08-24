// The collision this repairs is invisible in a diff — it is one id appearing twice in a 66k-line
// generated file — so the fixture below is a minimal Pods project reproducing exactly it: the SPM
// objects CocoaPods appends have taken the ids of the project object and its main group, and those
// two objects are therefore absent.
import { describe, expect, it } from 'vitest'
import { repairPodsSpmCollision } from './repair-pods-spm-collision.mjs'

const CLEAN = `// !$*UTF8*$!
{
	objects = {
		46EB2E00000000 /* Project object */ = {
			isa = PBXProject;
			mainGroup = 46EB2E00000010;
			productRefGroup = 46EB2E00000020 /* Products */;
			targets = (
			);
		};
		46EB2E00000010 /* MainGroup */ = {
			isa = PBXGroup;
			children = (
			);
		};
/* Begin PBXResourcesBuildPhase section */
	};
	rootObject = 46EB2E00000000 /* Project object */;
}
`

const DAMAGED = `// !$*UTF8*$!
{
	objects = {
		46EB2E00000000 /* XCRemoteSwiftPackageReference "Citadel" */ = {
			isa = XCRemoteSwiftPackageReference;
			repositoryURL = "https://github.com/orlandos-nl/Citadel.git";
		};
		46EB2E00000010 /* Citadel */ = {
			isa = XCSwiftPackageProductDependency;
			package = 46EB2E00000000 /* XCRemoteSwiftPackageReference "Citadel" */;
			productName = Citadel;
		};
/* Begin PBXResourcesBuildPhase section */
	};
	rootObject = 46EB2E00000000 /* Project object */;
}
`

describe('repairPodsSpmCollision', () => {
  it('gives the project object and its main group back', () => {
    const result = repairPodsSpmCollision(DAMAGED, CLEAN)
    expect(result).not.toBeNull()
    expect(result.text).toContain('isa = PBXProject;')
    expect(result.text).toContain('46EB2E00000010 /* MainGroup */')
    expect(result.evicted).toEqual(['46EB2E00000000', '46EB2E00000010'])
  })

  it('moves the SPM objects off the ids they squatted on, referrers included', () => {
    const { text } = repairPodsSpmCollision(DAMAGED, CLEAN)
    // The reference is no longer defined at the project object's id...
    expect(text).not.toMatch(/^\t\t46EB2E00000000 \/\* XCRemoteSwiftPackageReference/m)
    // ...and the product dependency that pointed at it followed the move.
    const moved = text.match(/^\t\t([0-9A-F]+) \/\* XCRemoteSwiftPackageReference "Citadel"/m)[1]
    expect(moved).not.toBe('46EB2E00000000')
    expect(text).toContain(`package = ${moved} /* XCRemoteSwiftPackageReference "Citadel" */;`)
    // The project object carries the reference it should have had all along.
    expect(text).toContain(`packageReferences = (\n\t\t\t\t${moved}`)
  })

  it('is a no-op on a project that was never damaged', () => {
    expect(repairPodsSpmCollision(CLEAN, CLEAN)).toBeNull()
  })
})
