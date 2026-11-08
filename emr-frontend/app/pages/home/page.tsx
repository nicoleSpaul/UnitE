import Image from "next/image";
import unitemricon from "../../../public/uniteemricon.png"

export default function Home() {
  return (
    <main className="bg-white text-black min-h-screen flex flex-col items-center px-6 py-16 gap-20">

        <h1 className="text-5xl font-bold" >Unite EMR Software</h1>
        <div>
            <Image 
                src={unitemricon}
                alt="Unite EMR"
                className="w-34 h-28"
            />
        </div>

      <section className="w-full max-w-6xl grid grid-cols-1 md:grid-cols-3 gap-8">
        <div className="flex flex-col gap-3 rounded-2xl border border-gray-200 p-6 shadow-sm">
            <i className="fas fa-exchange-alt self-center text-3xl text-blue-900 pb-6" aria-hidden="true"></i>
            <h2 className="text-xl font-semibold">Convert Any EMR</h2>
            <p className="text-gray-600 leading-relaxed">
            Our purpose is to enable fast conversion between electronic medical
            record data types.
            </p>
        </div>

        <div className="flex flex-col gap-3 rounded-2xl border border-gray-200 p-6 shadow-sm">
            <i className="fas fa-user-shield self-center text-3xl text-blue-900 pb-6" aria-hidden="true"></i>
            <h2 className="text-xl font-semibold">Privacy Guaranteed</h2>
            <p className="text-gray-600 leading-relaxed">
            As patient information is extremely protected and susceptible to
            privacy risks, we have taken that into account with parts of our
            implementation to show how it could be done on a larger scale.
            </p>
        </div>

        <div className="flex flex-col gap-3 rounded-2xl border border-gray-200 p-6 shadow-sm">
            <i className="fas fa-heartbeat self-center text-3xl text-blue-900 pb-6" aria-hidden="true"></i>
            <h2 className="text-xl font-semibold">Saves Time, Saves Lives</h2>
            <p className="text-gray-600 leading-relaxed">
            Countless doctor hours that could be spent saving lives are spent on
            menial tasks supporting cross-hospital or internal hospital data
            when they could be spent saving real lives.
            </p>
        </div>
      </section>

      <section className="w-full max-w-4xl flex flex-col gap-12">
        <div className="flex flex-col gap-4">
          <h2 className="text-3xl font-bold">How It Works</h2>
          <p className="text-gray-700 leading-relaxed">
            You can convert using any of the formats we handle into a universal
            format. HL7 FHIR, chosen for its wide implementation across many
            commonly used EMR software such as EPIC, Oracle, MEDITECH, and many
            more. During conversion, you can customize as much as you want depending
            on the headers/information you would like to extract from your
            document. Then, you can choose to export it as is or into one of the many file
            formats we offer. This includes an option to submit an example of
            the format you would like your data to be exported in.
          </p>
        </div>

        <div className="flex flex-col gap-4">
          <h2 className="text-3xl font-bold">Our Mission</h2>
          <p className="text-gray-700 leading-relaxed">
            Every year countless hours are lost to hospitals who take the time to 
            convert data between other hospitals or even internally. In many cases, tests which don't need to be 
            rerun are rerun, quesitons that don't need to be asked are reasked, and many other
            pieces of vital information are thrown away. Additionally, doctors often make these types 
            of retests because they don't have the time to 
            utilize what information is already there. These types of situations can be 
            incredibly stressful to patients both mentally and financially. Imagine being
            a patient who is struggling with your new diagnosis and is being asked the same 
            questions over and over by different sections of the same hospital never leaving your bed. It would 
            drive anyone insane, and make you doubt the integrity of your care.
          </p>
          <p className="text-gray-700 leading-relaxed">
            Imagine a world where electronic medical records of any type could be converted to 
            seamlessly integrate with different formats. That is the world that Unite EMR is 
            vying to create. 
          </p>
        </div>
      </section>
    </main>
  );
}