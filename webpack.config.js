const CopyWebpackPlugin = require('copy-webpack-plugin');
const path = require("path");

module.exports = {
  mode: "development",
  entry: "./src/index.ts",
  devtool: "eval-source-map",
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: "ts-loader",
        exclude: /node_modules/,
      },
    ],
  },
  resolve: {
    extensions: [ ".tsx", ".ts", ".js" ]
  },
  output: {
    filename: "bundle.js",
    path: path.resolve(__dirname, "public/inc"),
  },
  plugins: [
    new CopyWebpackPlugin([
      {
        from: './node_modules/@fortawesome/fontawesome-pro/webfonts',
        to: './fa/webfonts'
      }, {
        from: './node_modules/@fortawesome/fontawesome-pro/scss',
        to: './fa/scss'
      },
    ])
  ]
};