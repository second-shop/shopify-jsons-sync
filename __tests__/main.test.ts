import {mkdtemp, mkdir, readFile, writeFile} from 'fs/promises'
import {afterEach, describe, expect, test} from '@jest/globals'
import {tmpdir} from 'os'
import {dirname, join} from 'path'
import {
  getNewTemplatesToRemote,
  removeDisabledKeys,
  syncLocaleAndSettingsJSON,
  syncTemplateJSON,
  validateShopifyCliAccess
} from '../src/utils'

const originalCwd = process.cwd()

const writeJson = async (file: string, value: unknown): Promise<void> => {
  await mkdir(dirname(file), {recursive: true})
  await writeFile(file, JSON.stringify(value, null, 2))
}

describe('shopify json sync utilities', () => {
  afterEach(() => {
    process.chdir(originalCwd)
  })

  test('removeDisabledKeys only removes entries with disabled set to true', () => {
    expect(
      removeDisabledKeys({
        keep: {disabled: false, title: 'keep me'},
        remove: {disabled: true, title: 'remove me'},
        plain: {title: 'plain object'}
      })
    ).toEqual({
      keep: {disabled: false, title: 'keep me'},
      plain: {title: 'plain object'}
    })
  })

  test('syncLocaleAndSettingsJSON merges locales and config files', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'shopify-json-sync-'))
    process.chdir(workspace)

    await writeJson(join(workspace, 'locales/en.default.json'), {
      localOnly: 'local',
      shared: 'local'
    })
    await writeJson(join(workspace, 'remote/locales/en.default.json'), {
      remoteOnly: 'remote',
      shared: 'remote'
    })

    await writeJson(join(workspace, 'config/settings_data.json'), {
      current: {
        blocks: {
          keep: {disabled: false, title: 'keep-local'},
          localOnly: {title: 'local'}
        }
      }
    })
    await writeJson(join(workspace, 'remote/config/settings_data.json'), {
      current: {
        blocks: {
          keep: {disabled: false, title: 'keep-remote'},
          remove: {disabled: true, title: 'remove'}
        }
      }
    })

    const filesToPush = await syncLocaleAndSettingsJSON()

    expect(filesToPush.sort()).toEqual(
      ['config/settings_data.json', 'locales/en.default.json'].sort()
    )

    expect(
      JSON.parse(
        await readFile(join(workspace, 'locales/en.default.json'), 'utf8')
      )
    ).toEqual({
      localOnly: 'local',
      remoteOnly: 'remote',
      shared: 'remote'
    })

    expect(
      JSON.parse(
        await readFile(join(workspace, 'config/settings_data.json'), 'utf8')
      )
    ).toEqual({
      current: {
        blocks: {
          keep: {disabled: false, title: 'keep-remote'}
        }
      }
    })
  })

  test('syncLocaleAndSettingsJSON can skip settings data files', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'shopify-json-sync-'))
    process.chdir(workspace)

    await writeJson(join(workspace, 'locales/en.default.json'), {
      localOnly: 'local',
      shared: 'local'
    })
    await writeJson(join(workspace, 'remote/locales/en.default.json'), {
      remoteOnly: 'remote',
      shared: 'remote'
    })

    await writeJson(join(workspace, 'config/settings_data.json'), {
      current: {
        blocks: {
          localOnly: {title: 'local'}
        }
      }
    })
    await writeJson(join(workspace, 'remote/config/settings_data.json'), {
      current: {
        blocks: {
          remoteOnly: {title: 'remote'}
        }
      }
    })

    const filesToPush = await syncLocaleAndSettingsJSON({
      includeSettingsData: false
    })

    expect(filesToPush).toEqual(['locales/en.default.json'])
    expect(
      JSON.parse(
        await readFile(join(workspace, 'config/settings_data.json'), 'utf8')
      )
    ).toEqual({
      current: {
        blocks: {
          localOnly: {title: 'local'}
        }
      }
    })
  })

  test('syncTemplateJSON overwrites local templates with remote copies (no merge)', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'shopify-json-sync-'))
    process.chdir(workspace)

    await writeJson(join(workspace, 'templates/index.json'), {
      sections: {localOnly: {type: 'local'}},
      order: ['localOnly']
    })
    await writeJson(join(workspace, 'remote/templates/index.json'), {
      sections: {remoteOnly: {type: 'remote'}},
      order: ['remoteOnly']
    })

    await writeJson(join(workspace, 'templates/nested/page.json'), {
      foo: 'local'
    })
    await writeJson(join(workspace, 'remote/templates/nested/page.json'), {
      foo: 'remote',
      bar: 'remote'
    })

    const filesToPush = await syncTemplateJSON()

    expect(filesToPush.sort()).toEqual(
      ['templates/index.json', 'templates/nested/page.json'].sort()
    )

    expect(
      JSON.parse(await readFile(join(workspace, 'templates/index.json'), 'utf8'))
    ).toEqual({
      sections: {remoteOnly: {type: 'remote'}},
      order: ['remoteOnly']
    })

    expect(
      JSON.parse(
        await readFile(join(workspace, 'templates/nested/page.json'), 'utf8')
      )
    ).toEqual({
      foo: 'remote',
      bar: 'remote'
    })
  })

  test('getNewTemplatesToRemote only returns templates absent from remote', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'shopify-json-sync-'))
    process.chdir(workspace)

    await writeJson(join(workspace, 'templates/product.json'), {
      sections: {}
    })
    await writeJson(join(workspace, 'templates/collection.json'), {
      sections: {}
    })
    await writeJson(join(workspace, 'remote/templates/product.json'), {
      sections: {}
    })

    expect(await getNewTemplatesToRemote()).toEqual(['templates/collection.json'])
  })

  test('validateShopifyCliAccess fails clearly when Shopify CLI is missing', async () => {
    await expect(
      validateShopifyCliAccess('example.myshopify.com', async command => {
        if (command === 'shopify version') {
          throw new Error('command not found')
        }

        return ''
      })
    ).rejects.toThrow(
      'Shopify CLI is not available on PATH. Install it before running this action.'
    )
  })

  test('validateShopifyCliAccess fails clearly when store access is unavailable', async () => {
    await expect(
      validateShopifyCliAccess('example.myshopify.com', async command => {
        if (command === 'shopify version') {
          return '3.0.0'
        }

        throw new Error('not authenticated')
      })
    ).rejects.toThrow(
      'Shopify CLI could not access store "example.myshopify.com". Verify CLI authentication and store permissions before running this action.'
    )
  })
})
