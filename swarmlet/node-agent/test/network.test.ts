import { expect, test } from 'bun:test';
import { NetworkSampler, parseLinuxNetwork, parseMacNetwork } from '../probe/network.ts';
test('interface counters exclude loopback and duplicate macOS address rows',()=>{
  expect(parseLinuxNetwork('lo: 100 0 0 0 0 0 0 0 200 0\n eth0: 1000 0 0 0 0 0 0 0 2000 0')).toEqual([{name:'eth0',rx:1000,tx:2000}]);
  const mac='Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll\nen0 1500 <Link#4> ab:cd 1 0 1000 2 0 2000 0\nen0 1500 192.168.1 192.168.1.53 1 0 1000 2 0 2000 0\nlo0 16384 <Link#1> 00 1 0 10 1 0 10 0';
  expect(parseMacNetwork(mac)).toEqual([{name:'en0',rx:1000,tx:2000}]);
});
test('first samples, new interfaces and reset counters never manufacture network traffic',()=>{
  const sampler=new NetworkSampler();
  expect(sampler.rates([{name:'eth0',rx:1000,tx:2000}],1000)).toEqual([{name:'eth0'}]);
  expect(sampler.rates([{name:'eth0',rx:2000,tx:4000}],3000)).toEqual([{name:'eth0',rxBps:500,txBps:1000}]);
  expect(sampler.rates([{name:'eth0',rx:0,tx:0},{name:'wifi',rx:5000,tx:5000}],4000)).toEqual([{name:'eth0'},{name:'wifi'}]);
});
