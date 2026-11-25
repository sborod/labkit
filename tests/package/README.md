# Package verification

Run `npm run test:package` to build the SDK and check its package surface.
The tests import the built package by self-reference, check exported symbols
and rejected deep imports, inspect the pack whitelist and CSS boundary, and
typecheck the same fixture under Bundler and NodeNext resolution.
They do not install a separate copy.

The external consumer test performs a real installation into a temporary
project, then checks ESM imports, both TypeScript resolution modes and a
Vite production build with CSS:

```sh
npm run build
npm pack --ignore-scripts
npm run test:consumer -- "$PWD/labkit-0.1.0.tgz"
npm run test:consumer -- --git "git+file://$PWD#$(git rev-parse HEAD)"
```

Use the current archive version. The Git check exercises the install lifecycle
of the committed revision without remote authentication. The template smoke
test additionally runs the template's typecheck, tests and production build
against the packed candidate SDK.

CI runs these checks automatically. CSS tree-shaking without an explicit CSS
import is not covered.
