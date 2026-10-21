module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'docs', 'style', 'refactor', 'test', 'chore'],
    ],
    // No length limits anywhere in the message.
    'header-max-length': [0],
    'body-max-line-length': [0],
    'footer-max-line-length': [0],
  },
};
