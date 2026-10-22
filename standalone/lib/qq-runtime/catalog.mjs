// Official, unmodified release archive. Downloaded only by explicit prepare().
// This is an acquisition pin, not a redistribution license or live-QQ claim.
// Source layout and hashes were inspected without executing the archive.
export const officialNodeManifest={
  schema:1,platform:'win32',arch:'x64',preset:'official-node',
  version:'4.18.41',qqVersion:'9.9.31-49738',localUseApproved:true,redistribution:'unreviewed',
  entry:{executable:'node.exe',script:'index.js',main:'napcat/napcat.mjs'},
  artifacts:[{
    url:'https://github.com/NapNeko/NapCatQQ/releases/download/v4.18.41/NapCat.Shell.Windows.Node.zip',
    sha256:'51fbb10e7bcd56b0c2a6de86c37811e7518330e48a137ac689ab1e4d8627d3f0',
    maxBytes:150*1024*1024,
  }],
  criticalFiles:[
    {path:'node.exe',sha256:'7447c4ece014aa41fb2ff866c993c708e5a8213a00913cc2ac5049ea3ffc230d'},
    {path:'index.js',sha256:'5de31bef6cc1b48cef0229a8b22b32b3211e41253c3e75a9547e996becf9b388'},
    {path:'QQNT.dll',sha256:'2f9ae01c30fa624535439cab9ccc2ba56d95e5f2ec85e6182789cb3c9089f3b7'},
    {path:'wrapper.node',sha256:'a1e59891e743c271d641ee011f47aa887d9f7dfae6b3bb9292a03af759dec203'},
    {path:'napcat/napcat.mjs',sha256:'7c66d0239d7effe73ab6e4920eddef732a8066fb47cd19539541c72055c5f0aa'},
  ],
};
