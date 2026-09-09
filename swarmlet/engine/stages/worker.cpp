// Resident native Qwen35 stage/full-context endpoint. Local loopback only; mesh owns transport.
#include "llama.h"
#include "capsule_io.hpp"
#include "ggml-backend.h"
#include "nlohmann/json.hpp"
#include "cpp-httplib/httplib.h"
extern "C" {
#include "hash/sha256/sha256.h"
}
#include <algorithm>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <mutex>
#include <sstream>
#include <regex>
#include <map>
#include <unistd.h>
using json=nlohmann::json;
namespace fs=std::filesystem;
#ifndef MESH_ENGINE_ID
#define MESH_ENGINE_ID "unqualified"
#endif
#ifndef MESH_BUILD_CONFIG
#define MESH_BUILD_CONFIG "unknown"
#endif
static constexpr size_t MAX_STATE=512ULL<<20, MAX_BATCH=64;
static std::string hex(const unsigned char *p,size_t n){std::ostringstream s;for(size_t i=0;i<n;i++)s<<std::hex<<std::setw(2)<<std::setfill('0')<<int(p[i]);return s.str();}
static std::string sha(const std::vector<uint8_t>&b){unsigned char d[32];sha256_hash(d,b.data(),b.size());return hex(d,32);}
static std::string sha_json(const json&j){auto s=j.dump();return sha(std::vector<uint8_t>(s.begin(),s.end()));}
static std::string sha_file(const fs::path&p){std::ifstream f(p,std::ios::binary);if(!f)throw std::runtime_error("cannot open hash input");sha256_t h;sha256_init(&h);std::vector<unsigned char>b(1<<20);while(f){f.read((char*)b.data(),b.size());sha256_update(&h,b.data(),f.gcount());}unsigned char d[32];sha256_final(&h,d);return hex(d,32);}
static std::vector<uint8_t> read(const fs::path&p,size_t cap){auto n=fs::file_size(p);if(n>cap)throw std::runtime_error("file exceeds bound");std::vector<uint8_t>b(n);std::ifstream f(p,std::ios::binary);if(!f.read((char*)b.data(),n))throw std::runtime_error("short file");return b;}
struct Worker {
 llama_model*m=nullptr;llama_context*c=nullptr;const llama_vocab*v=nullptr;fs::path dir;
 std::string model_sha,session,binary_sha;json identity;int pos=0,emb=0,vocab=0;size_t eval_tokens=0;bool middle=false,input_stage=false;std::vector<float> last_logits, boundary;int capture_layer=-1;std::mutex mu;std::map<std::string,std::string> capsule_owners;
 static bool capture(ggml_tensor*t,bool ask,void*data){auto*w=(Worker*)data;bool match=w->capture_layer>=0&&std::string(ggml_get_name(t))=="l_out-"+std::to_string(w->capture_layer);if(ask)return match;if(match){if(t->type!=GGML_TYPE_F32)return false;size_t n=ggml_nelements(t);size_t old=w->boundary.size();w->boundary.resize(old+n);ggml_backend_tensor_get(t,w->boundary.data()+old,0,n*sizeof(float));}return true;}
 ~Worker(){if(c)llama_free(c);if(m)llama_model_free(m);}
 fs::path file(const std::string&name){if(name.empty()||name.size()>128||name.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.")!=std::string::npos||name=="."||name=="..")throw std::runtime_error("invalid filename");auto p=dir/name;if(fs::is_symlink(p))throw std::runtime_error("symlink rejected");return p;}
 static bool suffix(const std::string&s,const std::string&tail){return s.size()>=tail.size()&&s.compare(s.size()-tail.size(),tail.size(),tail)==0;}
 fs::path capsule(const std::string&name){if(!suffix(name,".state")&&!suffix(name,".state.json"))throw std::runtime_error("capsule filename required");return file(name);}
 std::vector<llama_token> tokenize(const std::string&text){if(text.size()>65536)throw std::runtime_error("text too large");int n=-llama_tokenize(v,text.data(),text.size(),nullptr,0,true,true);if(n<0)throw std::runtime_error("tokenization size failed");std::vector<llama_token>t(n);n=llama_tokenize(v,text.data(),text.size(),t.data(),t.size(),true,true);if(n<0)throw std::runtime_error("tokenization failed");t.resize(n);return t;}
 std::vector<uint8_t> piece(llama_token token){std::vector<char>b(512);int n=llama_token_to_piece(v,token,b.data(),b.size(),0,false);if(n<0){b.resize(-n);n=llama_token_to_piece(v,token,b.data(),b.size(),0,false);}if(n<0)throw std::runtime_error("piece decode failed");return std::vector<uint8_t>(b.begin(),b.begin()+n);}
 void reset(){llama_memory_clear(llama_get_memory(c),true);session.clear();pos=0;last_logits.clear();eval_tokens=0;}
 static std::string valid_session(const json&q){std::string s=q.at("session");if(s.empty()||s.size()>128)throw std::runtime_error("invalid session");return s;}
 void claim(const json&q){std::string s=valid_session(q);if(!session.empty()&&session!=s)throw std::runtime_error("session busy; explicit reset required");session=s;}
 json run(const json&q){std::lock_guard<std::mutex>guard(mu);std::string op=q.at("op");
  if(op=="status")return {{"identity",identity},{"binary_sha256",binary_sha},{"build_config",MESH_BUILD_CONFIG},{"pid",getpid()},{"session",session},{"position",pos},{"evaluated_tokens",eval_tokens},{"n_embd",emb},{"n_vocab",vocab}};
  if(op=="reset"){if(!session.empty()&&q.value("session","")!=session)throw std::runtime_error("session mismatch");reset();return {{"reset",true}};}
  if(op=="tokenize")return {{"tokens",tokenize(q.at("text"))}};
  if(op=="chat_tokens"){
   const auto&messages=q.at("messages");if(!messages.is_array()||messages.empty()||messages.size()>64)throw std::runtime_error("message count bound");
   std::vector<std::string> roles,contents;size_t bytes=0;
   for(const auto&msg:messages){std::string role=msg.at("role"),content=msg.at("content");if(role!="system"&&role!="user"&&role!="assistant")throw std::runtime_error("unsupported message role");bytes+=content.size();if(bytes>65536)throw std::runtime_error("message size bound");roles.push_back(role);contents.push_back(content);}
   std::vector<llama_chat_message> chat;for(size_t i=0;i<roles.size();i++)chat.push_back({roles[i].c_str(),contents[i].c_str()});
   auto tmpl=llama_model_chat_template(m,nullptr);if(!tmpl)throw std::runtime_error("model has no chat template");std::vector<char>buf(131072);int n=llama_chat_apply_template(tmpl,chat.data(),chat.size(),true,buf.data(),buf.size());if(n<0||n>65536)throw std::runtime_error("unsupported or oversized model chat template");return {{"tokens",tokenize(std::string(buf.data(),n))}};
  }
  if(op=="state_read"||op=="state_write"||op=="state_delete"){
   auto owner=valid_session(q);std::string name=q.at("file");auto p=capsule(name);if(!session.empty()&&session!=owner)throw std::runtime_error("session busy");
   auto found=capsule_owners.find(name);if(found!=capsule_owners.end()&&found->second!=owner)throw std::runtime_error("capsule owner mismatch");for(const auto&f:capsule_owners)if(f.second!=owner)throw std::runtime_error("transfer busy");
   if(op=="state_delete"){if(found==capsule_owners.end())throw std::runtime_error("unknown capsule");fs::remove(p);capsule_owners.erase(found);return {{"deleted",true}};}
   const size_t cap=suffix(name,".json")?(16ULL<<20):MAX_STATE;
   if(!q.at("offset").is_number_unsigned()&&!q.at("offset").is_number_integer())throw std::runtime_error("offset must be integer");int64_t off=q.at("offset");if(off<0||uint64_t(off)>cap)throw std::runtime_error("offset bound");
   if(op=="state_read"){
    if(found==capsule_owners.end())throw std::runtime_error("unknown capsule");int max=q.at("max_bytes");if(max<=0||max>262144)throw std::runtime_error("chunk bound");size_t total=fs::file_size(p);if(total>cap||size_t(off)>total)throw std::runtime_error("file bound");size_t n=std::min<size_t>(max,total-off);std::vector<uint8_t>b(n);std::ifstream f(p,std::ios::binary);f.seekg(off);if(!f.read((char*)b.data(),n))throw std::runtime_error("chunk read failed");return {{"data",b},{"next_offset",off+n},{"total_bytes",total},{"eof",off+n==total}};
   }
   const auto&data=q.at("data");if(!data.is_array()||data.empty()||data.size()>262144||uint64_t(off)+data.size()>cap)throw std::runtime_error("chunk bound");std::vector<uint8_t>b;for(const auto&v:data){if(!v.is_number_integer())throw std::runtime_error("byte must be integer");int val=v;if(val<0||val>255)throw std::runtime_error("byte bound");b.push_back(val);}
   if(found==capsule_owners.end()){if(off!=0||capsule_owners.size()>=2||fs::exists(p))throw std::runtime_error("new capsule requires empty path and capacity");capsule_owners[name]=owner;}
   else if(fs::file_size(p)!=uint64_t(off))throw std::runtime_error("chunk offset mismatch");
   try{capsule_io::write_closed(p,(char*)b.data(),b.size(),std::ios::app);}catch(...){capsule_io::cleanup_owned(p,name,capsule_owners);throw;}
   return {{"next_offset",off+b.size()},{"total_bytes",off+b.size()}};
  }
  if(op=="eval"){
   capture_layer=q.value("capture_layer",-1);boundary.clear();if(capture_layer>=llama_model_n_layer(m)||capture_layer < -1)throw std::runtime_error("capture layer bound");
   const bool compact=q.value("compact",false);
   int requested=q.at("position");if(requested!=pos)throw std::runtime_error("position mismatch");
   std::vector<llama_token>t;std::vector<float>a;bool tokens=q.contains("tokens");size_t n;
   if(tokens){if(input_stage)throw std::runtime_error("stage requires activations");t=q.at("tokens").get<std::vector<llama_token>>();n=t.size();for(auto x:t)if(x<0||x>=vocab)throw std::runtime_error("invalid token");}
   else {a=q.at("activations").get<std::vector<float>>();if(a.size()%emb)throw std::runtime_error("activation dimensions");n=a.size()/emb;for(float x:a)if(!std::isfinite(x))throw std::runtime_error("nonfinite activation");}
   if(!n||n>MAX_BATCH||pos+int(n)>int(llama_n_ctx(c)))throw std::runtime_error("batch/context bound");claim(q);
   llama_batch b=llama_batch_init(n,tokens?0:emb,1);b.n_tokens=n;
   const auto rope=llama_model_rope_type(m);const bool mrope=rope==LLAMA_ROPE_TYPE_MROPE||rope==LLAMA_ROPE_TYPE_IMROPE;
   if(!tokens&&mrope){free(b.pos);b.pos=(llama_pos*)calloc(n*4,sizeof(llama_pos));if(!b.pos){llama_batch_free(b);throw std::bad_alloc();}}
   for(size_t i=0;i<n;i++){if(tokens)b.token[i]=t[i];else std::copy_n(a.data()+i*emb,emb,b.embd+i*emb);b.pos[i]=pos+i;if(!tokens&&mrope){b.pos[n+i]=pos+i;b.pos[2*n+i]=pos+i;b.pos[3*n+i]=0;}b.n_seq_id[i]=1;b.seq_id[i][0]=0;b.logits[i]=1;}
   int rc=llama_decode(c,b);llama_batch_free(b);if(rc){reset();throw std::runtime_error("decode failed; session cleared");}pos+=n;eval_tokens+=n;
   json out={{"position",pos},{"evaluated_tokens",eval_tokens}};
   if(middle){auto*p=llama_get_embeddings(c);if(!p)throw std::runtime_error("missing boundary");out["activations"]=std::vector<float>(p,p+n*emb);}
   else{auto*p=llama_get_logits_ith(c,-1);if(!p)throw std::runtime_error("missing logits");last_logits.assign(p,p+vocab);if(!compact)out["logits"]=last_logits;llama_token token=std::max_element(last_logits.begin(),last_logits.end())-last_logits.begin();out["token"]=token;out["pieceBytes"]=piece(token);out["isEog"]=llama_vocab_is_eog(v,token);}
   if(capture_layer>=0)out["boundary"]=boundary;
   return out;
  }
  if(op=="export"){
   if(valid_session(q)!=session||session.empty())throw std::runtime_error("session mismatch");if(!pos)throw std::runtime_error("empty state");auto p=capsule(q.at("file"));if(!suffix(p.filename().string(),".state")||!capsule_owners.empty())throw std::runtime_error("one outstanding capsule pair allowed");if(fs::exists(p)||fs::exists(p.string()+".json"))throw std::runtime_error("state file exists");
   size_t n=llama_state_seq_get_size_ext(c,0,LLAMA_STATE_SEQ_FLAGS_NONE);if(!n||n>MAX_STATE)throw std::runtime_error("state size bound");std::vector<uint8_t>b(n);
   if(llama_state_seq_get_data_ext(c,b.data(),n,0,LLAMA_STATE_SEQ_FLAGS_NONE)!=n)throw std::runtime_error("state export incomplete");
   json meta={{"identity",identity},{"position",pos},{"bytes",n},{"sha256",sha(b)},{"session",session},{"last_logits",last_logits}};
   meta["envelope_sha256"]=sha_json(meta);
   capsule_io::write_pair(p,(char*)b.data(),n,meta.dump(),session,capsule_owners);meta.erase("last_logits");return meta;
  }
  if(op=="import"){
   auto incoming_session=valid_session(q);
   if(!session.empty()||pos)throw std::runtime_error("import requires empty context");auto p=file(q.at("file"));auto manifest=read(file(q.at("file").get<std::string>()+".json"),16<<20);auto meta=json::parse(manifest);auto envelope=meta.at("envelope_sha256");meta.erase("envelope_sha256");if(envelope!=sha_json(meta))throw std::runtime_error("envelope integrity mismatch");
   if(meta.at("identity")!=identity)throw std::runtime_error("state identity mismatch");if(meta.at("session")!=q.at("session"))throw std::runtime_error("state session mismatch");int next=meta.at("position");if(next<=0||next>int(llama_n_ctx(c)))throw std::runtime_error("state position bound");
   auto b=read(p,MAX_STATE);if(meta.at("bytes")!=b.size()||meta.at("sha256")!=sha(b))throw std::runtime_error("state integrity mismatch");auto l=meta.at("last_logits").get<std::vector<float>>();if((middle&&!l.empty())||(!middle&&l.size()!=size_t(vocab)))throw std::runtime_error("logits dimensions");for(float x:l)if(!std::isfinite(x))throw std::runtime_error("nonfinite logits");
   try {size_t used=llama_state_seq_set_data_ext(c,b.data(),b.size(),0,LLAMA_STATE_SEQ_FLAGS_NONE);if(used!=b.size())throw std::runtime_error("state import incomplete");if(llama_memory_seq_pos_max(llama_get_memory(c),0)!=next-1)throw std::runtime_error("state position metadata mismatch");session=incoming_session;pos=next;last_logits=std::move(l);}catch(...){reset();throw;}return {{"position",pos},{"evaluated_tokens",eval_tokens},{"logits",last_logits}};
  }
  throw std::runtime_error("unknown operation");
 }
};
int main(int argc,char**argv){try{
 if(argc==2&&std::string(argv[1])=="--identity"){std::cout<<json({{"schema",1},{"engine",MESH_ENGINE_ID},{"binary_sha256",sha_file(argv[0])},{"build_config",MESH_BUILD_CONFIG}}).dump()<<std::endl;return 0;}
 if(argc!=7)throw std::runtime_error("usage: mesh-stage-worker MODEL SHA256 STATE_DIR PORT GPU_LAYERS CTX");
 Worker w;w.binary_sha=sha_file(argv[0]);w.model_sha=sha_file(argv[1]);if(w.model_sha!=argv[2])throw std::runtime_error("model digest mismatch");w.dir=argv[3];fs::create_directories(w.dir);fs::permissions(w.dir,fs::perms::owner_all);int port=std::stoi(argv[4]),gpu=std::stoi(argv[5]),ctx=std::stoi(argv[6]);if(port<1024||port>65535||ctx<64||ctx>32768)throw std::runtime_error("port/context bounds");
 ggml_backend_load_all();llama_backend_init();auto mp=llama_model_default_params();mp.n_gpu_layers=gpu;w.m=llama_model_load_from_file(argv[1],mp);if(!w.m)throw std::runtime_error("model load failed");w.v=llama_model_get_vocab(w.m);w.emb=llama_model_n_embd(w.m);w.vocab=llama_vocab_n_tokens(w.v);
 char b[128];auto meta=[&](const char*k){int n=llama_model_meta_val_str(w.m,k,b,sizeof b);return n>0?std::string(b):std::string();};auto start=meta("mesh.stage.start"),end=meta("mesh.stage.end"),total=meta("mesh.stage.total");w.input_stage=!start.empty()&&std::stoi(start)>0;w.middle=!total.empty()&&end!=total;
 auto cp=llama_context_default_params();cp.n_ctx=ctx;cp.n_batch=MAX_BATCH;cp.n_ubatch=1;cp.flash_attn_type=LLAMA_FLASH_ATTN_TYPE_DISABLED;cp.n_seq_max=1;cp.n_threads=2;cp.n_threads_batch=2;cp.embeddings=w.middle;cp.pooling_type=LLAMA_POOLING_TYPE_NONE;cp.type_k=GGML_TYPE_F32;cp.type_v=GGML_TYPE_F32;cp.cb_eval=Worker::capture;cp.cb_eval_user_data=&w;w.c=llama_init_from_model(w.m,cp);if(!w.c)throw std::runtime_error("context init failed");
 w.identity={{"schema",1},{"engine",MESH_ENGINE_ID},{"model_sha256",w.model_sha},{"source_sha256",meta("mesh.stage.source_sha256").empty()?w.model_sha:meta("mesh.stage.source_sha256")},{"ctx",llama_n_ctx(w.c)},{"ubatch",llama_n_ubatch(w.c)},{"flash_attn","disabled"},{"cache_k","f32"},{"cache_v","f32"},{"stage_start",start},{"stage_end",end},{"stage_total",total}};
 httplib::Server s;s.set_payload_max_length(4<<20);
 s.set_pre_routing_handler([](const auto&req,auto&r){
  const auto host=req.get_header_value("Host");
  const bool local=std::regex_match(host,std::regex("^(localhost|127\\.0\\.0\\.1)(:[0-9]{1,5})?$"));
  const bool origin_ok=!req.has_header("Origin")||req.get_header_value("Origin")=="http://"+host;
  const auto content=req.get_header_value("Content-Type");
  const bool json_ok=req.method!="POST"||content=="application/json"||content=="application/json; charset=utf-8";
  if(!local||!origin_ok||!json_ok){r.status=403;r.set_content("{\"error\":\"local origin and JSON required\"}","application/json");return httplib::Server::HandlerResponse::Handled;}
  return httplib::Server::HandlerResponse::Unhandled;
 });s.Get("/health",[&](const auto&,auto&r){r.set_content(w.run({{"op","status"}}).dump(),"application/json");});s.Post("/command",[&](const auto&req,auto&r){try{r.set_content(w.run(json::parse(req.body)).dump(),"application/json");}catch(const std::exception&e){r.status=400;r.set_content(json({{"error",e.what()}}).dump(),"application/json");}});std::cout<<"ready port="<<port<<std::endl;if(!s.listen("127.0.0.1",port))throw std::runtime_error("listen failed");
 }catch(const std::exception&e){std::cerr<<e.what()<<std::endl;return 1;}}
