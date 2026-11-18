import { SPEC_FILE_NAME } from '@jsii/spec';
import { promises as fs } from 'fs';
import * as jsii from 'jsii';
import { TypeSystem } from 'jsii-reflect';
import { RosettaTabletReader } from 'jsii-rosetta';
import { tmpdir } from 'os';
import { join } from 'path';

import { Golang } from '../../lib/targets/go';

test('does not generate imports for unused types', async () => {
  const outDir = await fs.mkdtemp(join(tmpdir(), 'pacmak-golang-'));
  try {
    const tarball = join(outDir, 'mock-tarball.tgz');
    await fs.writeFile(tarball, 'Mock Tarball');

    const typeSystem = new TypeSystem();
    await typeSystem.load(require.resolve('./fixtures/base.jsii.json'));
    const assembly = await typeSystem.load(
      require.resolve('./fixtures/dependent.jsii.json'),
    );

    const rosetta = new RosettaTabletReader();
    const subject = new Golang({
      arguments: {},
      assembly,
      packageDir: '',
      rosetta,
      runtimeTypeChecking: true,
      targetName: 'golang',
    });

    await subject.generateCode(outDir, tarball);

    await expect(
      fs.readFile(join(outDir, assembly.name, `${assembly.name}.go`), 'utf-8'),
    ).resolves.not.toContain(
      'github.com/aws/jsii/packages/jsii-pacmak/test/targets/fixtures/base',
    );
  } finally {
    await fs.rm(outDir, { recursive: true });
  }
});

/**
 * See https://github.com/aws/jsii/issues/4985
 *
 * Submodules whose last path segment matches (e.g. `service` and
 * `interfaces.service`) both become Go packages named `service`. Type
 * references must still be qualified using the imported package identity, not
 * treated as same-package because the final names collide.
 */
test('qualifies types from submodules that share a Go package name', async () => {
  const compiled = jsii.compileJsiiForTest({
    'index.ts': `
      export * as service from './service';
      export * as interfaces from './interfaces';
    `,
    'interfaces/index.ts': `
      export * as service from './service';
    `,
    'interfaces/service.ts': `
      export interface IResource {
        readonly id: string;
      }
    `,
    'service/index.ts': `
      import { IResource } from '../interfaces/service';

      export class LocalHelper {
        public readonly ok = true;
      }

      export class Resource {
        public constructor(
          public readonly iface: IResource,
          public readonly helper: LocalHelper,
        ) {}
      }
    `,
  });

  const outDir = await fs.mkdtemp(join(tmpdir(), 'pacmak-golang-submodules-'));
  try {
    const assemblySpec = {
      ...compiled.assembly,
      targets: {
        go: { moduleName: 'example.test/demo' },
      },
    };

    const assemblyFile = join(outDir, SPEC_FILE_NAME);
    await fs.writeFile(assemblyFile, JSON.stringify(assemblySpec, null, 2));
    await fs.writeFile(join(outDir, 'mock-tarball.tgz'), 'Mock Tarball');

    const typeSystem = new TypeSystem();
    const assembly = await typeSystem.load(assemblyFile, { validate: false });

    const subject = new Golang({
      arguments: {},
      assembly,
      packageDir: '',
      rosetta: new RosettaTabletReader(),
      runtimeTypeChecking: true,
      targetName: 'golang',
    });

    await subject.generateCode(outDir, join(outDir, 'mock-tarball.tgz'));

    const resourceGo = await fs.readFile(
      join(outDir, 'testpkg', 'service', 'Resource.go'),
      'utf-8',
    );

    expect(resourceGo).toContain(
      '"example.test/demo/testpkg/interfaces/service"',
    );
    // Foreign type from interfaces/service must be qualified, even though that
    // package's name is also `service`.
    expect(resourceGo).toMatch(/iface\s+service\.IResource/);
    // Same-package references stay bare.
    expect(resourceGo).toMatch(/helper\s+LocalHelper/);
    expect(resourceGo).not.toMatch(/helper\s+service\.LocalHelper/);
  } finally {
    await fs.rm(outDir, { recursive: true });
  }
});
