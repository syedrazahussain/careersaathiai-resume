import mongoose from 'mongoose';

async function connectDB(){
    try {
        await mongoose.connect(process.env.MONGODB_URL)
        console.log("Mongodb is connected")
        
    } catch (error) {
        console.log("Not connected")
        console.log(error)
    }


}
export default connectDB

