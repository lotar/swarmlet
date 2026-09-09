#include "capsule_io.hpp"
#include <cassert>
#include <csignal>
#include <sys/resource.h>
int main(int argc, char **argv) {
    namespace fs=std::filesystem;
    const fs::path path=fs::path(argv[1])/"transfer.state";
    const std::string mode=argv[2];
    capsule_io::Owners owners;
    if(mode=="partial" || mode=="close") {
        signal(SIGXFSZ,SIG_IGN);rlimit limit{100,100};assert(setrlimit(RLIMIT_FSIZE,&limit)==0);
        bool rejected=false;
        try {capsule_io::write_pair(path,"x",1,std::string(mode=="partial"?20000:200,'x'),"session",owners);}
        catch(const std::ios_base::failure&) {rejected=true;}
        assert(rejected && owners.empty() && !fs::exists(path) && !fs::exists(path.string()+".json"));
    } else if(mode=="preexisting") {
        capsule_io::write_closed(path,"original",8);bool rejected=false;
        try {capsule_io::write_pair(path,"new",3,"meta","session",owners);}
        catch(const std::runtime_error&) {rejected=true;}
        std::ifstream f(path);std::string value;f>>value;
        assert(rejected && value=="original" && owners.empty());
        fs::remove(path);fs::create_symlink("missing-target",path.string()+".json");rejected=false;
        try {capsule_io::write_pair(path,"new",3,"meta","session",owners);}
        catch(const std::runtime_error&) {rejected=true;}
        assert(rejected && fs::is_symlink(path.string()+".json") && !fs::exists(path));
    } else if(mode=="retry") {
        fs::create_directory(path);capsule_io::write_closed(path/"busy","x",1);
        owners["transfer.state"]="session";capsule_io::cleanup_owned(path,"transfer.state",owners);
        assert(owners.size()==1 && fs::exists(path/"busy"));
        fs::remove(path/"busy");capsule_io::cleanup_owned(path,"transfer.state",owners);
        assert(owners.empty() && !fs::exists(path));
    } else if(mode=="append") {
        capsule_io::write_closed(path,"a",1);capsule_io::write_closed(path,"b",1,std::ios::app);
        std::ifstream f(path);std::string value;f>>value;assert(value=="ab");
    } else if(mode=="full") {
        bool rejected=false;try {capsule_io::write_closed("/dev/full","x",1);}catch(const std::ios_base::failure&) {rejected=true;}assert(rejected);
    } else return 2;
}
