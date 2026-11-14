import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { assignGroups, assigneeViewGroups } from '../inbox/assign.ts'
import { memberAvatar } from '../team/members.ts'
import { Avatar } from './kit.tsx'

const member = (user_id: string, name: string, avatar_version: string | null) => ({
  id: `m-${user_id}`,
  workspace_id: 'ws1',
  user_id,
  name,
  role: 'member',
  disabled: false,
  avatar_version,
  version: 1,
})

describe('Avatar', () => {
  test('shows the picture, cropped by its class, with the name for screen readers', () => {
    const html = renderToStaticMarkup(<Avatar name="Mike Brennan" src="/v1/avatars/u1.png?v=ab12" size={24} />)
    expect(html).toContain('class="k-avatar k-avatar-24 k-avatar-pic"')
    expect(html).toContain('aria-label="Mike Brennan"')
    expect(html).toContain('<img src="/v1/avatars/u1.png?v=ab12" alt=""')
    expect(html).not.toContain('MB')
  })

  test('shows the initials without a picture', () => {
    for (const src of [null, undefined, '']) {
      const html = renderToStaticMarkup(<Avatar name="Mike Brennan" src={src} size={20} />)
      expect(html).toBe('<span class="k-avatar k-avatar-20" role="img" aria-label="Mike Brennan">MB</span>')
    }
  })
})

describe('members with pictures', () => {
  test('a member row gives the picture address from its version, null without one', () => {
    expect(memberAvatar(member('u1', 'Mike', 'ab12'))).toBe('/v1/avatars/u1.png?v=ab12')
    expect(memberAvatar(member('u1', 'Mike', null))).toBeNull()
    expect(memberAvatar(undefined)).toBeNull()
  })

  test('the assign picker and the assignee views carry each member picture', () => {
    const members = [member('me', 'Mike Brennan', 'v1'), member('sam', 'Sam Ortiz', null)]
    const picks = assignGroups(members, 'me', [])[0]!.items
    expect(picks.map(p => [p.label, p.avatarSrc])).toEqual([
      ['Mike Brennan', '/v1/avatars/me.png?v=v1'],
      ['Sam Ortiz', null],
    ])
    const views = assigneeViewGroups(members, 'sam')[0]!.items.filter(v => v.tab === 'member')
    expect(views.map(v => v.avatarSrc)).toEqual(['/v1/avatars/me.png?v=v1'])
  })
})
