/// <reference path="../types/index.d.ts" />

import through from 'through';
import ts, { factory } from 'typescript';

const browserify = require('@cypress/browserify-preprocessor');

const isTestBlock = (name: string) => (node: ts.CallExpression | ts.PropertyAccessExpression) => {
  return ts.isIdentifier(node.expression) &&
    node.expression.escapedText === name;
};

const isDescribe = isTestBlock('describe');
const isContext = isTestBlock('context');
const isIt = isTestBlock('it');

const extractTags = () => {
  const includeTags = process.env.CYPRESS_INCLUDE_TAGS ? process.env.CYPRESS_INCLUDE_TAGS.split(',') : [];
  const excludeTags = process.env.CYPRESS_EXCLUDE_TAGS ? process.env.CYPRESS_EXCLUDE_TAGS.split(',') : [];

  return {
    includeTags,
    excludeTags,
  };
};

const calculateSkipChildren = (includeTags: string[], excludeTags: string[], tags: string[]): boolean => {
  const includeTest = includeTags.length === 0 || tags.some(tag => includeTags.includes(tag));
  const excludeTest = excludeTags.length > 0 && tags.some(tag => excludeTags.includes(tag));

  return !(includeTest && !excludeTest);
}

const removeTagsFromNode = (node: ts.Node, parentTags: string[], includeTags: string[], excludeTags: string[]): {
  node: ts.Node,
  tags: string[],
  skipChildren: boolean,
} => {
  if (ts.isCallExpression(node)) {
    const firstArg = node.arguments[0];
    if (ts.isArrayLiteralExpression(firstArg)) {
      const nodeTags = firstArg.elements.map((element: any) => element.text);
      const uniqueTags = [...new Set([...nodeTags, ...parentTags])];
      const skipChildren = calculateSkipChildren(includeTags, excludeTags, uniqueTags);

      // Create a new node removing the tag list as the first argument
      const newArgs: ts.NodeArray<ts.Expression> = factory.createNodeArray([...node.arguments.slice(1)]);
      const newExpression = factory.createCallExpression(node.expression, undefined, newArgs);
      return {
        node: newExpression,
        tags: uniqueTags,
        skipChildren,
      };
    }
  }
  return {
    node,
    tags: parentTags,
    skipChildren: false,
  };
}

const transformer = <T extends ts.Node>(context: ts.TransformationContext) => (rootNode: T) => {
  const { includeTags, excludeTags } = extractTags();

  const visit = (node: ts.Node, parentTags?: string[]): ts.Node | undefined => {
    let tags: string[] = parentTags ?? [];
    let returnNode = node;

    let skipChildren = false;

    if (ts.isCallExpression(node)) {
      const firstArg = node.arguments[0];

      if (ts.isIdentifier(node.expression)) {
        if (isDescribe(node) || isContext(node)) {
          if (ts.isArrayLiteralExpression(firstArg)) {
            // First arg is tags list
            const result = removeTagsFromNode(node, tags, includeTags, excludeTags);
            skipChildren = result.skipChildren;
            returnNode = result.node;
            tags = result.tags;
          }
        } else if (isIt(node)) {
          if (ts.isStringLiteral(firstArg)) {
            // First arg is title
            skipChildren = calculateSkipChildren(includeTags, excludeTags, tags);
          } else if (ts.isArrayLiteralExpression(firstArg)) {
            // First arg is tags list
            const result = removeTagsFromNode(node, tags, includeTags, excludeTags);
            skipChildren = result.skipChildren;
            returnNode = result.node;
          }
        }
      } else if (ts.isPropertyAccessExpression(node.expression)) {
        // Node contains a .skip or .only
        if (isIt(node.expression)) {
          if (ts.isArrayLiteralExpression(firstArg)) {
            // First arg is tags list
            const result = removeTagsFromNode(node, tags, includeTags, excludeTags);
            skipChildren = result.skipChildren;
            returnNode = result.node;
          }
        }
      }
    }

    if (skipChildren) {
      returnNode = factory.createEmptyStatement();
    } else {
      returnNode = ts.visitEachChild(returnNode, (node) => visit(node, tags), context);
    }

    return returnNode;
  };

  return ts.visitNode(rootNode, visit);
};

const processFile = (fileName: string, source: string) => {
  const printer = ts.createPrinter();

  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  const transformedResult = ts.transform<ts.SourceFile>(sourceFile, [transformer]);
  const transformedSourceFile: ts.SourceFile = transformedResult.transformed[0];
  const result = printer.printFile(transformedSourceFile);

  return result;
};

const transform = (fileName: string) => {
  let data = '';

  function ondata (d: through.ThroughStream) {
    data += d;
  }

  function onend (this: through.ThroughStream) {
    this.queue(processFile(fileName, data));
    this.emit('end');
  }

  return through(ondata, onend);
};

const preprocessor = () => {
  const options = {
    ...browserify.defaultOptions,
    typescript: require.resolve('typescript'),
    browserifyOptions: {
      ...browserify.defaultOptions.browserifyOptions,
      extensions: ['.ts'],
      transform: [
        ...browserify.defaultOptions.browserifyOptions.transform,
        (fileName: string) => transform(fileName),
      ],
    },
  };

  return browserify(options);
};

preprocessor.transform = transform;

module.exports = preprocessor;